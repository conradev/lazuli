//! Memory of the system.
use std::ptr::NonNull;

use bitos::BitUtils;
use gekko::{Address, Bat, MemoryManagement};

use crate::system::ipl::Ipl;

pub const RAM_LEN: usize = lazuli_abi::memory::MAIN_RAM_BYTES;
pub const L2C_LEN: usize = lazuli_abi::memory::L2C_BYTES;
pub const IPL_LEN: usize = lazuli_abi::memory::IPL_BYTES;

#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(transparent)]
pub struct PageTranslation(u16);

impl PageTranslation {
    const NO_MAPPING: Self = Self(1 << 15);

    #[inline(always)]
    pub fn new(physical_base: Option<u16>) -> Self {
        physical_base.map_or(Self::NO_MAPPING, Self)
    }

    #[inline(always)]
    pub fn base(&self) -> Option<u16> {
        (*self != Self::NO_MAPPING).then_some(self.0)
    }

    #[inline(always)]
    pub fn translate(&self, offset: u32) -> Option<u32> {
        if let Some(base) = self.base() {
            Some(offset.with_bits(17, 32, base as u32))
        } else {
            std::hint::cold_path();
            None
        }
    }
}

const PAGES_COUNT: usize = 1 << 15;
pub const FASTMEM_PAGE_BYTES: u32 = 1 << 17;
type TranslationLut = [PageTranslation; PAGES_COUNT];
type FastmemLut = [Option<NonNull<u8>>; PAGES_COUNT];

enum Region {
    Ram,
    L2c,
    Ipl,
}

pub const RAM_START: u32 = 0x0000_0000;
pub const RAM_END: u32 = RAM_START + RAM_LEN as u32 - 1;
pub const L2C_START: u32 = 0xE000_0000;
pub const L2C_END: u32 = L2C_START + L2C_LEN as u32 - 1;
pub const IPL_START: u32 = 0xFFF0_0000;
pub const IPL_END: u32 = IPL_START + (IPL_LEN as u32 / 2 - 1);

impl Region {
    fn of(addr: Address) -> Option<(Self, u32)> {
        let addr = addr.value();
        Some(match addr {
            RAM_START..=RAM_END => (Self::Ram, addr - RAM_START),
            L2C_START..=L2C_END => (Self::L2c, addr - L2C_START),
            IPL_START..=IPL_END => (Self::Ipl, addr - IPL_START),
            _ => return None,
        })
    }

    fn of_range(addr: Address, len: u32) -> Option<(Self, u32)> {
        let (region, offset) = Self::of(addr)?;
        let end = offset.checked_add(len)?;
        let region_len = match region {
            Self::Ram => RAM_LEN as u32,
            Self::L2c => L2C_LEN as u32,
            Self::Ipl => IPL_LEN as u32 / 2,
        };
        (end <= region_len).then_some((region, offset))
    }
}

pub struct Regions<'mem> {
    pub ram: &'mem mut [u8],
    pub l2c: &'mem mut [u8],
    pub ipl: &'mem [u8],
}

/// Fixed, externally owned RAM and locked-cache backing for a browser machine.
///
/// Requiring `&'static mut` arrays makes construction safe: the mapped bytes have the exact
/// architected sizes, cannot overlap when obtained through safe Rust, and outlive the [`Memory`]
/// that borrows them. The browser Wasm entrypoint may construct these arrays from sealed linear
/// memory in one small, audited unsafe boundary.
pub struct MappedMemoryBacking {
    ram: &'static mut [u8; RAM_LEN],
    l2c: &'static mut [u8; L2C_LEN],
    ipl: &'static mut [u8; IPL_LEN],
}

impl MappedMemoryBacking {
    #[must_use]
    pub fn new(
        ram: &'static mut [u8; RAM_LEN],
        l2c: &'static mut [u8; L2C_LEN],
        ipl: &'static mut [u8; IPL_LEN],
    ) -> Self {
        Self { ram, l2c, ipl }
    }

    /// Mutable IPL window used only while constructing the machine.
    pub fn ipl_mut(&mut self) -> &mut [u8; IPL_LEN] {
        self.ipl
    }
}

enum Backing {
    Owned(Box<[u8]>),
    Mapped(&'static mut [u8]),
}

impl Backing {
    fn zeroed(len: usize) -> Self {
        Self::Owned(vec![0; len].into_boxed_slice())
    }

    #[inline(always)]
    fn as_ptr(&self) -> *mut u8 {
        match self {
            Self::Owned(bytes) => bytes.as_ptr().cast_mut(),
            Self::Mapped(bytes) => bytes.as_ptr().cast_mut(),
        }
    }

    #[inline(always)]
    fn as_slice(&self) -> &[u8] {
        match self {
            Self::Owned(bytes) => bytes,
            Self::Mapped(bytes) => bytes,
        }
    }

    #[inline(always)]
    fn as_mut_slice(&mut self) -> &mut [u8] {
        match self {
            Self::Owned(bytes) => bytes,
            Self::Mapped(bytes) => bytes,
        }
    }
}

enum ReadOnlyBacking {
    Owned(Box<[u8]>),
    Mapped(&'static mut [u8]),
}

impl ReadOnlyBacking {
    fn copied(bytes: &[u8]) -> Self {
        Self::Owned(bytes.to_vec().into_boxed_slice())
    }

    #[inline(always)]
    fn as_ptr(&self) -> *mut u8 {
        match self {
            Self::Owned(bytes) => bytes.as_ptr().cast_mut(),
            Self::Mapped(bytes) => bytes.as_ptr().cast_mut(),
        }
    }

    #[inline(always)]
    fn as_slice(&self) -> &[u8] {
        match self {
            Self::Owned(bytes) => bytes,
            Self::Mapped(bytes) => bytes,
        }
    }
}

pub struct Memory {
    ram: Backing,
    l2c: Backing,
    ipl: ReadOnlyBacking,

    data_fastmem_lut_physical_read: Box<FastmemLut>,
    data_fastmem_lut_physical_write: Box<FastmemLut>,
    data_fastmem_lut_logical_read: Box<FastmemLut>,
    data_fastmem_lut_logical_write: Box<FastmemLut>,
    data_translation_lut: Box<TranslationLut>,
    inst_translation_lut: Box<TranslationLut>,
}

fn update_fastmem_lut(
    ram: *mut u8,
    l2c: *mut u8,
    ipl: *mut u8,
    lut: &mut FastmemLut,
    allow_ipl: bool,
    iter: impl IntoIterator<Item = (u32, u32)>,
) {
    for (logical_base, physical_base) in iter {
        let physical = Address(physical_base << 17);
        // A fastmem entry authorizes the complete 128 KiB guest page. Partial regions (notably
        // the 16 KiB locked cache) must stay on the bounds-checked slow path.
        let region = Region::of_range(physical, FASTMEM_PAGE_BYTES);

        let ptr = if let Some((region, offset)) = region {
            let base = match region {
                Region::Ram => ram,
                Region::L2c => l2c,
                Region::Ipl if allow_ipl => ipl,
                Region::Ipl => std::ptr::null_mut(),
            };

            if base.is_null() {
                base
            } else {
                unsafe { base.add(offset as usize) }
            }
        } else {
            std::ptr::null_mut()
        };

        lut[logical_base as usize] = NonNull::new(ptr);
    }
}

fn update_fastmem_lut_physical(
    ram: *mut u8,
    l2c: *mut u8,
    ipl: *mut u8,
    lut: &mut FastmemLut,
    allow_ipl: bool,
) {
    let iter = |a, b| ((a >> 17)..=(b >> 17)).map(|x| (x, x));
    let ram_iter = iter(RAM_START, RAM_END);
    let l2c_iter = iter(L2C_START, L2C_END);
    let ipl_iter = iter(IPL_START, IPL_END);
    update_fastmem_lut(ram, l2c, ipl, lut, allow_ipl, ram_iter);
    update_fastmem_lut(ram, l2c, ipl, lut, allow_ipl, l2c_iter);
    update_fastmem_lut(ram, l2c, ipl, lut, allow_ipl, ipl_iter);
}

fn update_translation_lut_with(translation: &mut TranslationLut, bat: &Bat) {
    let physical_start_base = (bat.physical_start().value() >> 17) as u16;
    let physical_end_base = (bat.physical_end().value() >> 17) as u16;
    let logical_start_base = bat.logical_start().value() >> 17;
    let logical_end_base = bat.logical_end().value() >> 17;

    let logical_range = logical_start_base..=logical_end_base;
    let physical_range = physical_start_base..=physical_end_base;
    let iter = logical_range.zip(physical_range);

    for (logical_base, physical_base) in iter {
        translation[logical_base as usize] = PageTranslation::new(Some(physical_base));
    }
}

impl Memory {
    pub fn new(ipl_data: &Ipl) -> Self {
        Self::from_backings(
            Backing::zeroed(RAM_LEN),
            Backing::zeroed(L2C_LEN),
            ReadOnlyBacking::copied(ipl_data),
        )
    }

    /// Constructs memory over the browser's fixed shared RAM and locked-cache windows.
    ///
    /// RAM, L2C, and IPL remain externally owned and are never copied or freed by [`Memory`].
    pub fn new_mapped(backing: MappedMemoryBacking) -> Self {
        let MappedMemoryBacking { ram, l2c, ipl } = backing;
        Self::from_backings(
            Backing::Mapped(ram),
            Backing::Mapped(l2c),
            ReadOnlyBacking::Mapped(ipl),
        )
    }

    fn from_backings(ram: Backing, l2c: Backing, ipl: ReadOnlyBacking) -> Self {
        debug_assert_eq!(ram.as_slice().len(), RAM_LEN);
        debug_assert_eq!(l2c.as_slice().len(), L2C_LEN);
        debug_assert_eq!(ipl.as_slice().len(), IPL_LEN);

        let mut data_fastmem_lut_physical_read = util::boxed_array(None);
        update_fastmem_lut_physical(
            ram.as_ptr(),
            l2c.as_ptr(),
            ipl.as_ptr(),
            &mut data_fastmem_lut_physical_read,
            true,
        );
        let mut data_fastmem_lut_physical_write = util::boxed_array(None);
        update_fastmem_lut_physical(
            ram.as_ptr(),
            l2c.as_ptr(),
            ipl.as_ptr(),
            &mut data_fastmem_lut_physical_write,
            false,
        );

        Self {
            ram,
            l2c,
            ipl,

            data_fastmem_lut_physical_read,
            data_fastmem_lut_physical_write,
            data_fastmem_lut_logical_read: util::boxed_array(None),
            data_fastmem_lut_logical_write: util::boxed_array(None),
            data_translation_lut: util::boxed_array(PageTranslation::NO_MAPPING),
            inst_translation_lut: util::boxed_array(PageTranslation::NO_MAPPING),
        }
    }

    #[inline(always)]
    pub fn ram(&self) -> &[u8] {
        self.ram.as_slice()
    }

    #[inline(always)]
    pub fn ram_mut(&mut self) -> &mut [u8] {
        self.ram.as_mut_slice()
    }

    #[inline(always)]
    pub fn l2c(&self) -> &[u8] {
        self.l2c.as_slice()
    }

    #[inline(always)]
    pub fn l2c_mut(&mut self) -> &mut [u8] {
        self.l2c.as_mut_slice()
    }

    #[inline(always)]
    pub fn ipl(&self) -> &[u8] {
        self.ipl.as_slice()
    }

    #[inline(always)]
    pub fn regions(&mut self) -> Regions<'_> {
        let ram = self.ram.as_mut_slice();
        let l2c = self.l2c.as_mut_slice();
        let ipl = self.ipl.as_slice();

        Regions { ram, l2c, ipl }
    }

    pub fn build_data_bat_lut(&mut self, dbats: &[Bat; 4]) {
        let _span = tracing::info_span!("building dbat lut").entered();

        self.data_fastmem_lut_logical_read.fill(None);
        self.data_fastmem_lut_logical_write.fill(None);
        self.data_translation_lut.fill(PageTranslation::NO_MAPPING);
        for (i, bat) in dbats.iter().enumerate() {
            if !bat.supervisor_mode() {
                tracing::warn!("dbat{i} is disabled in supervisor mode");
                continue;
            }

            tracing::info!(
                "dbat{i}: logical({}..={}) -> physical({}..={})",
                bat.logical_start(),
                bat.logical_end(),
                bat.physical_start(),
                bat.physical_end()
            );
            update_translation_lut_with(&mut self.data_translation_lut, bat);
            // Translated accesses deliberately remain off the legacy 128 KiB pointer LUT. Its
            // shape cannot encode PR/PP, first-matching BAT priority, hashed 4 KiB pages, or a
            // cross-page permission boundary. The machine-owned MMU and its permission-aware
            // sidecar are the only translated fast path.
        }
    }

    pub fn build_inst_bat_lut(&mut self, ibats: &[Bat; 4]) {
        let _span = tracing::info_span!("building ibat lut").entered();

        self.inst_translation_lut.fill(PageTranslation::NO_MAPPING);
        for (i, bat) in ibats.iter().enumerate() {
            if !bat.supervisor_mode() {
                tracing::warn!("ibat{i} is disabled in supervisor mode");
                continue;
            }

            tracing::info!(
                "ibat{i} ({:16X}): logical({}..={}) -> physical({}..={})",
                bat.to_bits(),
                bat.logical_start(),
                bat.logical_end(),
                bat.physical_start(),
                bat.physical_end()
            );
            update_translation_lut_with(&mut self.inst_translation_lut, bat);
        }
    }

    pub fn build_bat_lut(&mut self, memory: &MemoryManagement) {
        let _span = tracing::info_span!("building bat luts").entered();
        self.build_data_bat_lut(&memory.dbat);
        self.build_inst_bat_lut(&memory.ibat);
    }

    #[inline(always)]
    fn translate_addr(&self, lut: &TranslationLut, addr: Address) -> Option<Address> {
        let addr = addr.value();
        let logical_base = addr >> 17;
        let page = lut[logical_base as usize];
        page.translate(addr).map(Address)
    }

    pub fn translate_data_addr<A: Into<Address>>(&self, addr: A) -> Option<A>
    where
        Address: Into<A>,
    {
        self.translate_addr(&self.data_translation_lut, addr.into())
            .map(Into::into)
    }

    pub fn translate_inst_addr<A: Into<Address>>(&self, addr: A) -> Option<A>
    where
        Address: Into<A>,
    {
        self.translate_addr(&self.inst_translation_lut, addr.into())
            .map(Into::into)
    }

    /// Returns the fastmem LUT.
    #[inline(always)]
    pub fn data_fastmem_lut_logical_read(&self) -> &FastmemLut {
        &self.data_fastmem_lut_logical_read
    }

    /// Returns the logical fastmem LUT safe for writes. Read-only IPL pages are absent.
    #[inline(always)]
    pub fn data_fastmem_lut_logical_write(&self) -> &FastmemLut {
        &self.data_fastmem_lut_logical_write
    }

    /// Returns the physical fastmem LUT for reads.
    #[inline(always)]
    pub fn data_fastmem_lut_physical_read(&self) -> &FastmemLut {
        &self.data_fastmem_lut_physical_read
    }

    /// Returns the physical fastmem LUT safe for writes. Read-only IPL pages are absent.
    #[inline(always)]
    pub fn data_fastmem_lut_physical_write(&self) -> &FastmemLut {
        &self.data_fastmem_lut_physical_write
    }

    /// Returns the raw wasm32 LUT address used by resident translated blocks.
    ///
    /// The portable JIT uses one conservative table for both loads and stores.  Selecting the
    /// write-safe table keeps read-only IPL pages on the checked Rust hook path instead of
    /// allowing a generated store to reuse a read-only pointer.  Translated accesses currently
    /// use the empty logical table and therefore also fall through to the machine-owned MMU.
    #[inline(always)]
    pub fn resident_fastmem_write_lut_ptr(&self, translated: bool) -> *const Option<NonNull<u8>> {
        let lut = if translated {
            &self.data_fastmem_lut_logical_write
        } else {
            &self.data_fastmem_lut_physical_write
        };
        lut.as_ptr()
    }
}

unsafe impl Send for Memory {}

#[cfg(test)]
mod tests {
    use super::*;

    fn boxed_array<const N: usize>(value: u8) -> Box<[u8; N]> {
        match vec![value; N].into_boxed_slice().try_into() {
            Ok(bytes) => bytes,
            Err(_) => unreachable!("vector was created at the requested array length"),
        }
    }

    fn test_ipl() -> Ipl {
        Ipl::new(vec![0; IPL_LEN])
    }

    #[test]
    fn owned_constructor_retains_independent_backing() {
        let ipl = test_ipl();
        let mut memory = Memory::new(&ipl);
        assert_eq!(memory.ram().len(), RAM_LEN);
        assert_eq!(memory.l2c().len(), L2C_LEN);
        assert_eq!(memory.ipl(), &*ipl);

        memory.ram_mut()[0x1234] = 0x5a;
        memory.l2c_mut()[0x234] = 0xa5;
        assert_eq!(memory.ram()[0x1234], 0x5a);
        assert_eq!(memory.l2c()[0x234], 0xa5);
    }

    #[test]
    fn mapped_backing_is_exactly_visible_and_not_freed_on_drop() {
        let ram = Box::into_raw(boxed_array::<RAM_LEN>(0));
        let l2c = Box::into_raw(boxed_array::<L2C_LEN>(0));
        let ipl = Box::into_raw(boxed_array::<IPL_LEN>(0));
        unsafe {
            (*ram)[0x40] = 0x12;
            (*l2c)[0x80] = 0x34;
            (*ipl)[0x100] = 0x56;
        }

        let backing = MappedMemoryBacking::new(
            // SAFETY: These boxes remain allocated until after `memory` is dropped below. Their
            // ranges are disjoint, and no other references are used while `memory` owns them.
            unsafe { &mut *ram },
            unsafe { &mut *l2c },
            unsafe { &mut *ipl },
        );
        let mut memory = Memory::new_mapped(backing);

        assert_eq!(memory.ram().as_ptr(), ram.cast::<u8>());
        assert_eq!(memory.l2c().as_ptr(), l2c.cast::<u8>());
        assert_eq!(memory.ipl().as_ptr(), ipl.cast::<u8>());
        assert_eq!(memory.ram()[0x40], 0x12);
        assert_eq!(memory.l2c()[0x80], 0x34);
        assert_eq!(memory.ipl()[0x100], 0x56);
        assert_eq!(
            memory.data_fastmem_lut_physical_read()[0]
                .expect("physical RAM fastmem entry")
                .as_ptr(),
            ram.cast::<u8>()
        );
        let ipl_page = (IPL_START >> 17) as usize;
        assert!(memory.data_fastmem_lut_physical_read()[ipl_page].is_some());
        assert!(memory.data_fastmem_lut_physical_write()[ipl_page].is_none());

        memory.ram_mut()[0x41] = 0xab;
        memory.l2c_mut()[0x81] = 0xcd;
        drop(memory);

        // Reclaiming both boxes proves `Memory` did not free mapped storage. Values written via
        // the emulator are still present in the exact host backing.
        let ram = unsafe { Box::from_raw(ram) };
        let l2c = unsafe { Box::from_raw(l2c) };
        let ipl = unsafe { Box::from_raw(ipl) };
        assert_eq!(ram[0x41], 0xab);
        assert_eq!(l2c[0x81], 0xcd);
        assert_eq!(ipl[0x100], 0x56);
    }
}
