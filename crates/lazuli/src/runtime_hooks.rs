//! Shared synchronous hooks used by generated PowerPC blocks.
//!
//! The machine semantics in this module are deliberately independent of any JIT backend,
//! browser binding, or JavaScript adapter. Generated native code and resident WebAssembly code
//! can wrap the same operations in their respective calling conventions without duplicating
//! translation, exception, reservation, quantization, or invalidation policy.

use gekko::{
    Address, Cpu, DEQUANTIZATION_LUT, DmaDirection, Exception, QUANTIZATION_LUT, QuantReg,
    QuantizedType,
};

use crate::Primitive;
use crate::runtime::{
    AddressSpaceGeneration, AddressSpaceUpdate, CachedBlock, InstructionAddressSpaceTracker,
};
use crate::system::bus::{
    DataAccessFault, DataAccessTarget, DataReservationFault, ResidentDataAccessError,
    ResidentDataRead, ResidentMmioError,
};
use crate::system::mem::{L2C_LEN, RAM_LEN};
use crate::system::mmu::{Mpc750Mmu, TranslationEffect};
use crate::system::{self, System};

/// A generated-block hook's control-flow result.
///
/// The first three numeric values intentionally match the portable scalar-read ABI. This lets a
/// thin C/Wasm wrapper return this discriminant directly for reads while still making cache
/// invalidation an explicit Rust result for state-changing hooks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum HookOutcome {
    Fault       = 0,
    Complete    = 1,
    Yield       = 2,
    Invalidated = 3,
}

/// The Rust-owned cache selection described by a hook result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum HookInvalidationKind {
    None            = 0,
    /// One architected 32-byte instruction-cache line.
    InstructionLine = 1,
    /// Every retained instruction block.
    AllInstructions = 2,
    /// Blocks depending on one MPC750 TLB set.
    TranslationSet  = 3,
    /// Blocks owned by one exact retired instruction-address-space generation.
    AddressSpace    = 4,
}

/// `physical` names a valid physical line when this bit is present in [`HookInvalidation::flags`].
pub const INVALIDATION_HAS_PHYSICAL: u32 = 1;

/// Fixed-width metadata allowing Rust code-cache ownership to apply a hook invalidation.
///
/// This is intentionally an integer-only `repr(C)` record. A browser-facing wrapper may copy it
/// into shared Wasm memory, but JavaScript is never asked to decide which guest blocks it selects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct HookInvalidation {
    pub kind: HookInvalidationKind,
    pub effective: u32,
    pub physical: u32,
    pub length: u32,
    pub generation_lo: u32,
    pub generation_hi: u32,
    /// Kind-specific information. For `TranslationSet`, bits 0..8 are the set, bits 8..16 are
    /// retired ITLB entries, and bits 16..24 are retired DTLB entries.
    pub auxiliary: u32,
    pub flags: u32,
}

impl HookInvalidation {
    pub const NONE: Self = Self {
        kind: HookInvalidationKind::None,
        effective: 0,
        physical: 0,
        length: 0,
        generation_lo: 0,
        generation_hi: 0,
        auxiliary: 0,
        flags: 0,
    };

    fn instruction_line(effective: Address, physical: Option<Address>) -> Self {
        Self {
            kind: HookInvalidationKind::InstructionLine,
            effective: effective.value(),
            physical: physical.map_or(0, Address::value),
            length: 32,
            generation_lo: 0,
            generation_hi: 0,
            auxiliary: 0,
            flags: if physical.is_some() {
                INVALIDATION_HAS_PHYSICAL
            } else {
                0
            },
        }
    }

    const fn all_instructions() -> Self {
        Self {
            kind: HookInvalidationKind::AllInstructions,
            ..Self::NONE
        }
    }

    const fn translation_set(
        effective: Address,
        set: u8,
        instruction_entries: u8,
        data_entries: u8,
    ) -> Self {
        Self {
            kind: HookInvalidationKind::TranslationSet,
            effective: effective.value(),
            auxiliary: set as u32
                | ((instruction_entries as u32) << 8)
                | ((data_entries as u32) << 16),
            ..Self::NONE
        }
    }

    const fn address_space(generation: AddressSpaceGeneration) -> Self {
        Self {
            kind: HookInvalidationKind::AddressSpace,
            generation_lo: generation.0 as u32,
            generation_hi: (generation.0 >> 32) as u32,
            ..Self::NONE
        }
    }

    /// The exact retired generation carried by an address-space invalidation.
    pub const fn generation(self) -> Option<AddressSpaceGeneration> {
        if matches!(self.kind, HookInvalidationKind::AddressSpace) {
            Some(AddressSpaceGeneration(
                self.generation_lo as u64 | ((self.generation_hi as u64) << 32),
            ))
        } else {
            None
        }
    }

    /// Tests one Rust-owned block record against this invalidation selector.
    ///
    /// Callers use this predicate with `CodeCache::invalidate_where` or
    /// `ColdCompileCoordinator::invalidate_where`; the returned `CachedBlock` values retain the
    /// exact slot/nonce identities that must be cleared from the Wasm function table.
    pub fn selects(self, block: &CachedBlock) -> bool {
        match self.kind {
            HookInvalidationKind::None => false,
            HookInvalidationKind::AllInstructions => true,
            HookInvalidationKind::AddressSpace => self
                .generation()
                .is_some_and(|generation| block.generation == generation),
            HookInvalidationKind::TranslationSet => {
                let set = self.auxiliary as u8;
                block
                    .dependencies()
                    .iter()
                    .any(|dependency| Mpc750Mmu::tlb_set_index(dependency.effective.value()) == set)
            }
            HookInvalidationKind::InstructionLine => (0..self.length).any(|offset| {
                block.covers_effective(Address(self.effective.wrapping_add(offset)))
                    || (self.flags & INVALIDATION_HAS_PHYSICAL != 0
                        && block.covers_physical(Address(self.physical.wrapping_add(offset))))
            }),
        }
    }
}

/// Complete fixed-width result of one synchronous generated-block hook.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct HookResult {
    pub outcome: HookOutcome,
    /// DSISR on a data-access fault; otherwise zero.
    pub detail: u32,
    pub invalidation: HookInvalidation,
}

const _: () = assert!(size_of::<HookOutcome>() == 4);
const _: () = assert!(size_of::<HookInvalidationKind>() == 4);
const _: () = assert!(size_of::<HookInvalidation>() == 32);
const _: () = assert!(size_of::<HookResult>() == 40);

impl HookResult {
    pub const COMPLETE: Self = Self {
        outcome: HookOutcome::Complete,
        detail: 0,
        invalidation: HookInvalidation::NONE,
    };

    pub const YIELD: Self = Self {
        outcome: HookOutcome::Yield,
        detail: 0,
        invalidation: HookInvalidation::NONE,
    };

    const fn fault(dsisr: u32) -> Self {
        Self {
            outcome: HookOutcome::Fault,
            detail: dsisr,
            invalidation: HookInvalidation::NONE,
        }
    }

    const fn invalidated(invalidation: HookInvalidation) -> Self {
        Self {
            outcome: HookOutcome::Invalidated,
            detail: 0,
            invalidation,
        }
    }
}

/// Whether a completed generated memory hook may remain inside the resident dispatcher.
///
/// This is deliberately separate from [`HookResult`]'s stable C record: it is Rust-owned policy
/// derived from the exact physical mapping already used by the access, not host-authored ABI
/// metadata.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookMemoryBoundary {
    Resident,
    Device,
}

impl From<DataAccessTarget> for HookMemoryBoundary {
    fn from(target: DataAccessTarget) -> Self {
        match target {
            DataAccessTarget::Memory => Self::Resident,
            DataAccessTarget::Mmio => Self::Device,
        }
    }
}

/// Complete Rust result of one scalar or quantized memory hook.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemoryHookResult {
    pub result: HookResult,
    pub boundary: HookMemoryBoundary,
}

/// Scalar resident read result before the browser machine decides whether to cross an async EFB
/// renderer boundary. The physical aperture address is carried from the one completed
/// architectural translation and is safe to retain across a cooperative load retry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResidentMemoryRead {
    Complete(MemoryHookResult),
    EfbPeek { physical: u32 },
}

impl MemoryHookResult {
    const fn resident(result: HookResult) -> Self {
        Self {
            result,
            boundary: HookMemoryBoundary::Resident,
        }
    }

    fn completed(result: HookResult, target: DataAccessTarget) -> Self {
        Self {
            result,
            boundary: target.into(),
        }
    }
}

/// Shared runtime state needed by synchronous generated-block hooks.
#[derive(Debug, Clone)]
pub struct MachineRuntimeHooks {
    address_space: InstructionAddressSpaceTracker,
}

impl MachineRuntimeHooks {
    /// Starts instruction identity from the supplied architected CPU state.
    pub fn new(cpu: &Cpu) -> Self {
        let mut address_space = InstructionAddressSpaceTracker::default();
        // Initial synchronization cannot exhaust generation one.
        let synchronized = address_space.synchronize(cpu);
        debug_assert!(synchronized.is_ok());
        Self { address_space }
    }

    pub fn current_generation(&self) -> AddressSpaceGeneration {
        self.address_space
            .current()
            .unwrap_or(AddressSpaceGeneration(1))
    }

    fn synchronize_address_space_with_policy(
        &mut self,
        system: &System,
        invalidate_all_on_change: bool,
    ) -> HookResult {
        match self.address_space.synchronize(&system.cpu) {
            Ok(AddressSpaceUpdate::Unchanged(_)) => HookResult::COMPLETE,
            Ok(AddressSpaceUpdate::Changed { retired, .. }) => {
                HookResult::invalidated(if invalidate_all_on_change {
                    HookInvalidation::all_instructions()
                } else {
                    retired.map_or(HookInvalidation::NONE, HookInvalidation::address_space)
                })
            }
            Err(_) => HookResult {
                outcome: HookOutcome::Fault,
                detail: 0,
                invalidation: HookInvalidation::all_instructions(),
            },
        }
    }

    /// Synchronizes IR, PR, IBAT, SR, and SDR1 identity after architected state was published.
    ///
    /// A retained exact namespace switch exits the current dispatcher block without retiring
    /// code. If the bounded namespace table displaced one LRU signature, the returned selector
    /// names only that exact generation.
    pub fn synchronize_address_space(&mut self, system: &System) -> HookResult {
        self.synchronize_address_space_with_policy(system, false)
    }

    /// Re-enters generation one after the caller synchronously retired every code/table record.
    pub fn reset_address_space_after_full_invalidation(&mut self, system: &System) -> HookResult {
        self.address_space
            .reset_after_full_invalidation(&system.cpu);
        HookResult::invalidated(HookInvalidation::NONE)
    }

    /// Performs a scalar slow read and publishes exact DAR/DSISR on failure.
    pub fn read_slow<P: Primitive>(
        system: &mut System,
        addr: Address,
        value: &mut P,
    ) -> HookResult {
        Self::read_slow_classified(system, addr, value).result
    }

    /// Performs a scalar slow read and classifies the exact translated backing used.
    pub fn read_slow_classified<P: Primitive>(
        system: &mut System,
        addr: Address,
        value: &mut P,
    ) -> MemoryHookResult {
        match system.read_slow_result_classified(addr) {
            Ok((read, target)) => {
                *value = read;
                MemoryHookResult::completed(HookResult::COMPLETE, target)
            }
            Err(fault) => MemoryHookResult::resident(record_data_access_fault(system, addr, fault)),
        }
    }

    /// Resident scalar read using the authenticated instruction-start cycle for exact MMIO state.
    pub fn read_slow_classified_at<P: Primitive>(
        system: &mut System,
        addr: Address,
        value: &mut P,
        observed_cycle: u64,
    ) -> Result<MemoryHookResult, ResidentMmioError> {
        match system.read_slow_result_classified_at(addr, observed_cycle) {
            Ok((read, target)) => {
                *value = read;
                Ok(MemoryHookResult::completed(HookResult::COMPLETE, target))
            }
            Err(ResidentDataAccessError::Access(fault)) => Ok(MemoryHookResult::resident(
                record_data_access_fault(system, addr, fault),
            )),
            Err(ResidentDataAccessError::Mmio(error)) => Err(error),
        }
    }

    /// Resident scalar read that defers an aligned EFB aperture word without fabricating DSI.
    pub fn read_slow_classified_at_deferred<P: Primitive>(
        system: &mut System,
        addr: Address,
        value: &mut P,
        observed_cycle: u64,
    ) -> Result<ResidentMemoryRead, ResidentMmioError> {
        match system.read_result_classified_at_deferred(addr, observed_cycle) {
            Ok(ResidentDataRead::Complete {
                value: read,
                target,
            }) => {
                *value = read;
                Ok(ResidentMemoryRead::Complete(MemoryHookResult::completed(
                    HookResult::COMPLETE,
                    target,
                )))
            }
            Ok(ResidentDataRead::EfbPeek { physical }) => {
                Ok(ResidentMemoryRead::EfbPeek { physical })
            }
            Err(ResidentDataAccessError::Access(fault)) => Ok(ResidentMemoryRead::Complete(
                MemoryHookResult::resident(record_data_access_fault(system, addr, fault)),
            )),
            Err(ResidentDataAccessError::Mmio(error)) => Err(error),
        }
    }

    /// Performs a scalar slow write and publishes exact DAR/DSISR on failure.
    pub fn write_slow<P: Primitive>(system: &mut System, addr: Address, value: P) -> HookResult {
        Self::write_slow_classified(system, addr, value).result
    }

    /// Performs a scalar slow write and classifies the exact translated backing used.
    pub fn write_slow_classified<P: Primitive>(
        system: &mut System,
        addr: Address,
        value: P,
    ) -> MemoryHookResult {
        match system.write_slow_result_classified(addr, value) {
            Ok(target) => MemoryHookResult::completed(HookResult::COMPLETE, target),
            Err(fault) => MemoryHookResult::resident(record_data_access_fault(system, addr, fault)),
        }
    }

    /// Resident scalar write using the authenticated instruction-start cycle for VI/SI state.
    pub fn write_slow_classified_at<P: Primitive>(
        system: &mut System,
        addr: Address,
        value: P,
        observed_cycle: u64,
    ) -> Result<MemoryHookResult, ResidentMmioError> {
        match system.write_slow_result_classified_at(addr, value, observed_cycle) {
            Ok(target) => Ok(MemoryHookResult::completed(HookResult::COMPLETE, target)),
            Err(ResidentDataAccessError::Access(fault)) => Ok(MemoryHookResult::resident(
                record_data_access_fault(system, addr, fault),
            )),
            Err(ResidentDataAccessError::Mmio(error)) => Err(error),
        }
    }

    /// Performs `lwarx` memory semantics and creates a physical 32-byte reservation.
    pub fn load_reserve(system: &mut System, addr: Address, value: &mut i32) -> HookResult {
        let physical = match system.translate_data_reservation_addr(addr, false) {
            Ok(physical) => physical,
            Err(fault) => return record_data_reservation_fault(system, addr, fault, false),
        };
        let Some(loaded) = system.read_data_reservation_phys(physical) else {
            return record_data_reservation_fault(
                system,
                addr,
                DataReservationFault::Backing,
                false,
            );
        };

        *value = loaded;
        system.cpu.reservation.reserve(physical);
        HookResult::COMPLETE
    }

    /// Performs `stwcx.` memory semantics. `stored` is initialized on every return path.
    pub fn store_conditional(
        system: &mut System,
        addr: Address,
        value: i32,
        stored: &mut bool,
    ) -> HookResult {
        *stored = false;
        let physical = match system.translate_data_reservation_addr(addr, true) {
            Ok(physical) => physical,
            Err(fault) => return record_data_reservation_fault(system, addr, fault, true),
        };

        // Even without a reservation, stwcx. performs write-class translation and protection.
        // It then completes as not-stored without probing the translated backing.
        if !system.cpu.reservation.is_valid() {
            return HookResult::COMPLETE;
        }

        // MPC750 reservations are not address-tag compared by stwcx.: any completed conditional
        // store succeeds while the processor's reservation remains live.
        if !system.write_data_reservation_phys(physical, value) {
            return record_data_reservation_fault(
                system,
                addr,
                DataReservationFault::Backing,
                true,
            );
        }
        system.cpu.reservation.clear();
        *stored = true;
        HookResult::COMPLETE
    }

    /// Reads and dequantizes one paired-single element. `size` is zero on failure.
    pub fn read_quantized(
        system: &mut System,
        addr: Address,
        gqr: QuantReg,
        value: &mut f64,
        size: &mut u8,
    ) -> HookResult {
        Self::read_quantized_classified(system, addr, gqr, value, size).result
    }

    /// Reads and dequantizes one paired-single element, retaining its exact target class.
    pub fn read_quantized_classified(
        system: &mut System,
        addr: Address,
        gqr: QuantReg,
        value: &mut f64,
        size: &mut u8,
    ) -> MemoryHookResult {
        let observed_cycle = system.scheduler.elapsed();
        Self::read_quantized_classified_at(system, addr, gqr, value, size, observed_cycle)
            .unwrap_or_else(|_| MemoryHookResult::resident(HookResult::fault(0)))
    }

    /// Resident quantized read using the exact observed cycle for a translated MMIO target.
    pub fn read_quantized_classified_at(
        system: &mut System,
        addr: Address,
        gqr: QuantReg,
        value: &mut f64,
        size: &mut u8,
        observed_cycle: u64,
    ) -> Result<MemoryHookResult, ResidentMmioError> {
        *size = 0;
        let ty = gqr.load_type();
        let Some(type_size) = quantized_size(ty) else {
            return Ok(MemoryHookResult::resident(HookResult::fault(0)));
        };
        let scale = if ty == QuantizedType::Float {
            0
        } else {
            gqr.load_scale().value()
        };

        let read = match ty {
            QuantizedType::U8 => system
                .read_memory_result_classified_at::<u8>(addr, observed_cycle)
                .map(|(x, target)| (x as f64, target)),
            QuantizedType::U16 => system
                .read_memory_result_classified_at::<u16>(addr, observed_cycle)
                .map(|(x, target)| (x as f64, target)),
            QuantizedType::I8 => system
                .read_memory_result_classified_at::<i8>(addr, observed_cycle)
                .map(|(x, target)| (x as f64, target)),
            QuantizedType::I16 => system
                .read_memory_result_classified_at::<i16>(addr, observed_cycle)
                .map(|(x, target)| (x as f64, target)),
            QuantizedType::Float => system
                .read_memory_result_classified_at::<u32>(addr, observed_cycle)
                .map(|(x, target)| (f32::from_bits(x) as f64, target)),
            QuantizedType::Reserved0 | QuantizedType::Reserved1 | QuantizedType::Reserved2 => {
                unreachable!("reserved quantized types were rejected above")
            }
        };
        let (read, target) = match read {
            Ok(read) => read,
            Err(ResidentDataAccessError::Access(fault)) => {
                return Ok(MemoryHookResult::resident(record_data_access_fault(
                    system, addr, fault,
                )));
            }
            Err(ResidentDataAccessError::Mmio(error)) => return Err(error),
        };

        *value = read * DEQUANTIZATION_LUT[(scale as usize) & 0x3f];
        *size = type_size;
        Ok(MemoryHookResult::completed(HookResult::COMPLETE, target))
    }

    /// Quantizes and writes one paired-single element. `size` is zero on failure.
    pub fn write_quantized(
        system: &mut System,
        addr: Address,
        gqr: QuantReg,
        value: f64,
        size: &mut u8,
    ) -> HookResult {
        Self::write_quantized_classified(system, addr, gqr, value, size).result
    }

    /// Quantizes and writes one paired-single element, retaining its exact target class.
    pub fn write_quantized_classified(
        system: &mut System,
        addr: Address,
        gqr: QuantReg,
        value: f64,
        size: &mut u8,
    ) -> MemoryHookResult {
        let observed_cycle = system.scheduler.elapsed();
        Self::write_quantized_classified_at(system, addr, gqr, value, size, observed_cycle)
            .unwrap_or_else(|_| MemoryHookResult::resident(HookResult::fault(0)))
    }

    /// Resident quantized write using the exact observed cycle for a translated MMIO target.
    pub fn write_quantized_classified_at(
        system: &mut System,
        addr: Address,
        gqr: QuantReg,
        value: f64,
        size: &mut u8,
        observed_cycle: u64,
    ) -> Result<MemoryHookResult, ResidentMmioError> {
        *size = 0;
        let ty = gqr.store_type();
        let Some(type_size) = quantized_size(ty) else {
            return Ok(MemoryHookResult::resident(HookResult::fault(0)));
        };
        let scale = if ty == QuantizedType::Float {
            0
        } else {
            gqr.store_scale().value()
        };
        let scaled = value * QUANTIZATION_LUT[(scale as usize) & 0x3f];
        let result = match ty {
            QuantizedType::U8 => {
                system.write_memory_result_classified_at(addr, scaled as u8, observed_cycle)
            }
            QuantizedType::U16 => {
                system.write_memory_result_classified_at(addr, scaled as u16, observed_cycle)
            }
            QuantizedType::I8 => {
                system.write_memory_result_classified_at(addr, scaled as i8, observed_cycle)
            }
            QuantizedType::I16 => {
                system.write_memory_result_classified_at(addr, scaled as i16, observed_cycle)
            }
            QuantizedType::Float => system.write_memory_result_classified_at(
                addr,
                (scaled as f32).to_bits(),
                observed_cycle,
            ),
            QuantizedType::Reserved0 | QuantizedType::Reserved1 | QuantizedType::Reserved2 => {
                unreachable!("reserved quantized types were rejected above")
            }
        };
        let target = match result {
            Ok(target) => target,
            Err(ResidentDataAccessError::Access(fault)) => {
                return Ok(MemoryHookResult::resident(record_data_access_fault(
                    system, addr, fault,
                )));
            }
            Err(ResidentDataAccessError::Mmio(error)) => return Err(error),
        };

        *size = type_size;
        Ok(MemoryHookResult::completed(HookResult::COMPLETE, target))
    }

    /// Raises one typed internal CPU exception and synchronizes the resulting IR/PR state.
    pub fn raise_exception(&mut self, system: &mut System, exception: Exception) -> HookResult {
        system.cpu.raise_exception(exception);
        self.synchronize_address_space(system)
    }

    /// Raises a raw-vector internal exception without trusting an invalid host discriminant.
    pub fn raise_exception_vector(&mut self, system: &mut System, vector: u32) -> HookResult {
        let Some(exception) = exception_from_vector(vector) else {
            return HookResult::fault(0);
        };
        self.raise_exception(system, exception)
    }

    /// Describes the exact effective/physical instruction line selected by `icbi`.
    pub fn invalidate_instruction_cache_line(system: &mut System, addr: Address) -> HookResult {
        let effective = addr.align_down(32);
        let physical = if system.cpu.supervisor.config.msr.instr_addr_translation() {
            system
                .translate_instruction_mmu(effective, TranslationEffect::Probe)
                .ok()
                .map(|mapping| Address(mapping.physical).align_down(32))
        } else {
            Some(effective)
        };
        HookResult::invalidated(HookInvalidation::instruction_line(effective, physical))
    }

    /// Requests retirement of every instruction block/cache line.
    pub const fn clear_instruction_cache() -> HookResult {
        HookResult::invalidated(HookInvalidation::all_instructions())
    }

    /// Performs architected set-scoped `tlbie` and returns its exact Rust cache selector.
    pub fn tlbie(system: &mut System, effective: Address) -> HookResult {
        let invalidated = system.invalidate_translation(effective);
        HookResult::invalidated(HookInvalidation::translation_set(
            effective,
            invalidated.set,
            invalidated.instruction_entries,
            invalidated.data_entries,
        ))
    }

    /// Orders prior TLB invalidations. The JIT/Wasm call boundary is the synchronization point.
    pub fn tlbsync(system: &mut System) -> HookResult {
        system.mmu.tlbsync();
        HookResult::COMPLETE
    }

    /// Publishes an MSR write, services EE changes, and synchronizes IR/PR identity.
    pub fn msr_changed(&mut self, system: &mut System) -> HookResult {
        system.scheduler.schedule_now(system::pi::check_interrupts);
        self.synchronize_address_space(system)
    }

    pub fn segment_register_changed(&mut self, system: &System) -> HookResult {
        self.synchronize_address_space(system)
    }

    pub fn sdr1_changed(&mut self, system: &System) -> HookResult {
        self.synchronize_address_space(system)
    }

    pub fn instruction_bat_changed(&mut self, system: &mut System) -> HookResult {
        let bats = system.cpu.supervisor.memory.ibat.clone();
        system.mem.build_inst_bat_lut(&bats);
        // Preserve the legacy browser's stricter IBAT barrier: a changed IBAT signature retires
        // every block even though the exact namespace interner could otherwise distinguish it.
        self.synchronize_address_space_with_policy(system, true)
    }

    /// DBAT changes rebuild data fastmem but do not change instruction cache identity.
    pub fn data_bat_changed(system: &mut System) -> HookResult {
        let bats = system.cpu.supervisor.memory.dbat.clone();
        system.mem.build_data_bat_lut(&bats);
        HookResult::COMPLETE
    }

    /// Executes one locked-cache DMA using the browser-proven bounded and wrapping rules.
    ///
    /// MEM1 accepts its physical address plus the two ordinary cached/uncached aliases. The
    /// 16-KiB locked cache wraps, including a transfer that crosses its end. Invalid MEM1 ranges
    /// are ignored after the command bits are acknowledged, matching the hardware-facing browser
    /// model without exposing a guest-controlled slice panic.
    pub fn locked_cache_dma(system: &mut System) -> HookResult {
        let dma = system.cpu.supervisor.config.dma.clone();
        if !dma.lower.trigger() {
            if dma.lower.flush() {
                system.cpu.supervisor.config.dma.lower.set_flush(false);
            }
            return HookResult::COMPLETE;
        }

        let length = dma.length() as usize;
        let ram_offset = main_ram_alias_offset(dma.mem_address(), length);
        if let Some(ram_offset) = ram_offset {
            let cache_address = dma.cache_address().value() as usize;
            match dma.lower.direction() {
                DmaDirection::FromRamToCache => {
                    invalidate_wrapping_locked_cache_reservation(
                        &mut system.cpu.reservation,
                        cache_address,
                        length,
                    );
                    let source = system.mem.ram()[ram_offset..ram_offset + length].to_vec();
                    copy_to_wrapping_locked_cache(system.mem.l2c_mut(), cache_address, &source);
                }
                DmaDirection::FromCacheToRam => {
                    system
                        .cpu
                        .reservation
                        .invalidate_range(Address(ram_offset as u32), length);
                    let mut source = vec![0; length];
                    copy_from_wrapping_locked_cache(system.mem.l2c(), cache_address, &mut source);
                    system.mem.ram_mut()[ram_offset..ram_offset + length].copy_from_slice(&source);
                }
            }
        }

        system.cpu.supervisor.config.dma.lower.set_trigger(false);
        system.cpu.supervisor.config.dma.lower.set_flush(false);
        HookResult::COMPLETE
    }
}

fn main_ram_alias_offset(address: Address, length: usize) -> Option<usize> {
    let address = address.value();
    let offset = if address < RAM_LEN as u32 {
        address
    } else if (0x8000_0000..0x8000_0000 + RAM_LEN as u32).contains(&address) {
        address - 0x8000_0000
    } else if (0xc000_0000..0xc000_0000 + RAM_LEN as u32).contains(&address) {
        address - 0xc000_0000
    } else {
        return None;
    } as usize;
    offset
        .checked_add(length)
        .is_some_and(|end| end <= RAM_LEN)
        .then_some(offset)
}

fn copy_to_wrapping_locked_cache(cache: &mut [u8], address: usize, source: &[u8]) {
    debug_assert_eq!(cache.len(), L2C_LEN);
    let mut copied = 0;
    while copied < source.len() {
        let offset = address.wrapping_add(copied) & (L2C_LEN - 1);
        let chunk = (source.len() - copied).min(L2C_LEN - offset);
        cache[offset..offset + chunk].copy_from_slice(&source[copied..copied + chunk]);
        copied += chunk;
    }
}

fn copy_from_wrapping_locked_cache(cache: &[u8], address: usize, destination: &mut [u8]) {
    debug_assert_eq!(cache.len(), L2C_LEN);
    let mut copied = 0;
    while copied < destination.len() {
        let offset = address.wrapping_add(copied) & (L2C_LEN - 1);
        let chunk = (destination.len() - copied).min(L2C_LEN - offset);
        destination[copied..copied + chunk].copy_from_slice(&cache[offset..offset + chunk]);
        copied += chunk;
    }
}

fn invalidate_wrapping_locked_cache_reservation(
    reservation: &mut gekko::LoadStoreReservation,
    address: usize,
    length: usize,
) {
    let mut visited = 0;
    while visited < length {
        let offset = address.wrapping_add(visited) & (L2C_LEN - 1);
        let chunk = (length - visited).min(L2C_LEN - offset);
        reservation.invalidate_range(Address(0xe000_0000 + offset as u32), chunk);
        visited += chunk;
    }
}

fn record_data_access_fault(
    system: &mut System,
    addr: Address,
    fault: DataAccessFault,
) -> HookResult {
    let dsisr = fault.dsisr();
    system.cpu.supervisor.exception.dar = addr.value();
    system.cpu.supervisor.exception.dsisr = dsisr;
    HookResult::fault(dsisr)
}

fn record_data_reservation_fault(
    system: &mut System,
    addr: Address,
    fault: DataReservationFault,
    write: bool,
) -> HookResult {
    let dsisr = fault.dsisr(write);
    system.cpu.supervisor.exception.dar = addr.value();
    system.cpu.supervisor.exception.dsisr = dsisr;
    HookResult::fault(dsisr)
}

const fn quantized_size(ty: QuantizedType) -> Option<u8> {
    match ty {
        QuantizedType::Float => Some(4),
        QuantizedType::U8 | QuantizedType::I8 => Some(1),
        QuantizedType::U16 | QuantizedType::I16 => Some(2),
        QuantizedType::Reserved0 | QuantizedType::Reserved1 | QuantizedType::Reserved2 => None,
    }
}

const fn exception_from_vector(vector: u32) -> Option<Exception> {
    match vector {
        0x0100 => Some(Exception::Reset),
        0x0200 => Some(Exception::MachineCheck),
        0x0300 => Some(Exception::DSI),
        0x0400 => Some(Exception::ISI),
        0x0500 => Some(Exception::Interrupt),
        0x0600 => Some(Exception::Alignment),
        0x0700 => Some(Exception::Program),
        0x0800 => Some(Exception::FloatUnavailable),
        0x0900 => Some(Exception::Decrementer),
        0x0c00 => Some(Exception::Syscall),
        0x0d00 => Some(Exception::Trace),
        0x0f00 => Some(Exception::PerformanceMonitor),
        0x1300 => Some(Exception::Breakpoint),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use gekko::Bat;
    use lazuli_abi::PhysicalRange;

    use super::*;
    use crate::modules::audio::NopAudioModule;
    use crate::modules::debug::NopDebugModule;
    use crate::modules::disk::NopDiskModule;
    use crate::modules::input::NopInputModule;
    use crate::modules::render::NopRenderModule;
    use crate::modules::vertex::NopVertexModule;
    use crate::runtime::InstructionPageDependency;
    use crate::system::{Config, Modules};

    fn test_system() -> System {
        System::new(
            Modules {
                audio: Box::new(NopAudioModule),
                debug: Box::new(NopDebugModule),
                disk: Box::new(NopDiskModule),
                input: Box::new(NopInputModule),
                render: Box::new(NopRenderModule),
                vertex: Box::new(NopVertexModule),
            },
            Config {
                ipl_lle: false,
                ipl: None,
                sideload: None,
                perform_efb_copies: false,
                uart_escape: false,
            },
        )
    }

    fn bat(upper: u32, lower: u32) -> Bat {
        Bat::from_bits(u64::from(upper) << 32 | u64::from(lower))
    }

    #[test]
    fn scalar_faults_publish_page_protection_direct_store_and_backing_causes() {
        let effective = Address(0x9000_1020);
        let mut value = 0x55aa_55aai32;

        let mut page = test_system();
        page.cpu
            .supervisor
            .config
            .msr
            .set_data_addr_translation(true);
        let result = MachineRuntimeHooks::read_slow(&mut page, effective, &mut value);
        assert_eq!(result.outcome, HookOutcome::Fault);
        assert_eq!(result.detail, 0x4000_0000);
        assert_eq!(page.cpu.supervisor.exception.dar, effective.value());
        assert_eq!(value, 0x55aa_55aa);

        let mut protected = test_system();
        protected
            .cpu
            .supervisor
            .config
            .msr
            .set_data_addr_translation(true);
        protected.cpu.supervisor.memory.dbat[0] = bat(0x9000_0002, 0);
        let result = MachineRuntimeHooks::write_slow(&mut protected, effective, 0x1234_5678u32);
        assert_eq!(result.outcome, HookOutcome::Fault);
        assert_eq!(result.detail, 0x0a00_0000);
        assert_eq!(protected.cpu.supervisor.exception.dar, effective.value());

        let mut direct = test_system();
        direct
            .cpu
            .supervisor
            .config
            .msr
            .set_data_addr_translation(true);
        direct.cpu.supervisor.memory.sr[9] = 0x8000_0000;
        let result = MachineRuntimeHooks::read_slow(&mut direct, effective, &mut value);
        assert_eq!(result.outcome, HookOutcome::Fault);
        assert_eq!(result.detail, 0x0400_0000);

        // An arbitrary guest physical address fails closed instead of becoming zero storage.
        let mut unbacked = test_system();
        let address = Address(0x4000_0000);
        let result = MachineRuntimeHooks::read_slow(&mut unbacked, address, &mut value);
        assert_eq!(result.outcome, HookOutcome::Fault);
        assert_eq!(result.detail, 0);
        assert_eq!(unbacked.cpu.supervisor.exception.dar, address.value());
        let result = MachineRuntimeHooks::write_slow(&mut unbacked, address, 7u64);
        assert_eq!(result.outcome, HookOutcome::Fault);
        assert_eq!(result.detail, 0x0200_0000);
    }

    #[test]
    fn completed_memory_hooks_classify_the_exact_translated_target() {
        let mut system = test_system();
        system.write_phys_slow(Address(0x100), 0x1122_3344u32);

        let mut value = 0;
        let ram =
            MachineRuntimeHooks::read_slow_classified(&mut system, Address(0x100), &mut value);
        assert_eq!(ram.result.outcome, HookOutcome::Complete);
        assert_eq!(ram.boundary, HookMemoryBoundary::Resident);
        assert_eq!(value, 0x1122_3344);

        let cause = MachineRuntimeHooks::read_slow_classified(
            &mut system,
            Address(0x0c00_3000),
            &mut value,
        );
        assert_eq!(cause.result.outcome, HookOutcome::Complete);
        assert_eq!(cause.boundary, HookMemoryBoundary::Device);

        let mask = MachineRuntimeHooks::write_slow_classified(
            &mut system,
            Address(0x0c00_3004),
            0x0000_0800u32,
        );
        assert_eq!(mask.result.outcome, HookOutcome::Complete);
        assert_eq!(mask.boundary, HookMemoryBoundary::Device);

        let mask_before = system.read_phys_slow::<u32>(Address(0x0c00_3004));
        let mut size = 99;
        let mut quantized = 0.0;
        let u8_load = QuantReg::from_bits(4 << 16);
        let quantized_mmio = MachineRuntimeHooks::read_quantized_classified(
            &mut system,
            Address(0x0c00_3000),
            u8_load,
            &mut quantized,
            &mut size,
        );
        assert_eq!(quantized_mmio.result.outcome, HookOutcome::Fault);
        assert_eq!(quantized_mmio.result.detail, 0);
        assert_eq!(quantized_mmio.boundary, HookMemoryBoundary::Resident);
        assert_eq!(size, 0);
        assert_eq!(system.cpu.supervisor.exception.dar, 0x0c00_3000);
        assert_eq!(
            system.read_phys_slow::<u32>(Address(0x0c00_3004)),
            mask_before
        );

        let u8_store = QuantReg::from_bits(4);
        size = 99;
        let rejected_store = MachineRuntimeHooks::write_quantized_classified(
            &mut system,
            Address(0x0c00_3004),
            u8_store,
            255.0,
            &mut size,
        );
        assert_eq!(rejected_store.result.outcome, HookOutcome::Fault);
        assert_eq!(rejected_store.result.detail, 0x0200_0000);
        assert_eq!(rejected_store.boundary, HookMemoryBoundary::Resident);
        assert_eq!(size, 0);
        assert_eq!(system.cpu.supervisor.exception.dar, 0x0c00_3004);
        assert_eq!(
            system.read_phys_slow::<u32>(Address(0x0c00_3004)),
            mask_before
        );

        system.processor.fifo_start = Address(0x1000);
        system.processor.fifo_end = Address(0x1020);
        system.processor.fifo_current.set_address(Address(0x1000));
        for byte in 0..32u8 {
            size = 0;
            let accepted = MachineRuntimeHooks::write_quantized_classified_at(
                &mut system,
                Address(0x0c00_8000 + u32::from(byte & 0x1f)),
                u8_store,
                f64::from(byte),
                &mut size,
                0,
            )
            .unwrap();
            assert_eq!(accepted.result.outcome, HookOutcome::Complete);
            assert_eq!(accepted.boundary, HookMemoryBoundary::Device);
            assert_eq!(size, 1);
        }
        assert_eq!(
            &system.mem.ram()[0x1000..0x1020],
            &(0..32u8).collect::<Vec<_>>()
        );
        assert_eq!(system.processor.fifo_current.address(), Address(0x1020));

        let fault = MachineRuntimeHooks::read_slow_classified(
            &mut system,
            Address(0x4000_0000),
            &mut value,
        );
        assert_eq!(fault.result.outcome, HookOutcome::Fault);
        assert_eq!(fault.boundary, HookMemoryBoundary::Resident);
    }

    #[test]
    fn reservation_semantics_are_physical_nonspecific_and_fail_closed() {
        let mut system = test_system();
        system.write_phys_slow(Address(0x100), 0x1122_3344i32);
        let mut loaded = 0;
        assert_eq!(
            MachineRuntimeHooks::load_reserve(&mut system, Address(0x100), &mut loaded).outcome,
            HookOutcome::Complete
        );
        assert_eq!(loaded, 0x1122_3344);
        assert_eq!(
            system.cpu.reservation.physical_granule(),
            Some(Address(0x100))
        );

        let mut stored = false;
        assert_eq!(
            MachineRuntimeHooks::store_conditional(
                &mut system,
                Address(0x200),
                0x5566_7788,
                &mut stored,
            )
            .outcome,
            HookOutcome::Complete
        );
        assert!(stored);
        assert_eq!(system.read_phys_slow::<i32>(Address(0x200)), 0x5566_7788);

        // No reservation: translation occurs, but unbacked storage is deliberately not probed.
        stored = true;
        assert_eq!(
            MachineRuntimeHooks::store_conditional(
                &mut system,
                Address(0x4000_0000),
                1,
                &mut stored,
            )
            .outcome,
            HookOutcome::Complete
        );
        assert!(!stored);

        system
            .cpu
            .supervisor
            .config
            .msr
            .set_data_addr_translation(true);
        let fault =
            MachineRuntimeHooks::load_reserve(&mut system, Address(0x9000_0000), &mut loaded);
        assert_eq!(fault.outcome, HookOutcome::Fault);
        assert_eq!(fault.detail, 0x4000_0000);
    }

    #[test]
    fn quantized_hooks_round_trip_and_reject_reserved_or_unbacked_inputs() {
        let mut system = test_system();
        let u8_both = QuantReg::from_bits(4 | (4 << 16));
        let mut size = 99;
        assert_eq!(
            MachineRuntimeHooks::write_quantized(
                &mut system,
                Address(0x300),
                u8_both,
                23.75,
                &mut size,
            )
            .outcome,
            HookOutcome::Complete
        );
        assert_eq!(size, 1);
        assert_eq!(system.read_phys_slow::<u8>(Address(0x300)), 23);

        let mut value = -1.0;
        assert_eq!(
            MachineRuntimeHooks::read_quantized(
                &mut system,
                Address(0x300),
                u8_both,
                &mut value,
                &mut size,
            )
            .outcome,
            HookOutcome::Complete
        );
        assert_eq!(size, 1);
        assert!((value - 23.0).abs() < f64::EPSILON);

        let reserved_load = QuantReg::from_bits(1 << 16);
        assert_eq!(
            MachineRuntimeHooks::read_quantized(
                &mut system,
                Address(0x300),
                reserved_load,
                &mut value,
                &mut size,
            )
            .outcome,
            HookOutcome::Fault
        );
        assert_eq!(size, 0);

        assert_eq!(
            MachineRuntimeHooks::read_quantized(
                &mut system,
                Address(0x4000_0000),
                u8_both,
                &mut value,
                &mut size,
            )
            .outcome,
            HookOutcome::Fault
        );
        assert_eq!(size, 0);
        assert_eq!(system.cpu.supervisor.exception.dar, 0x4000_0000);
    }

    #[test]
    fn instruction_address_space_generation_tracks_only_instruction_inputs() {
        let mut system = test_system();
        let mut hooks = MachineRuntimeHooks::new(&system.cpu);
        assert_eq!(hooks.current_generation(), AddressSpaceGeneration(1));
        assert_eq!(
            hooks.synchronize_address_space(&system).outcome,
            HookOutcome::Complete
        );

        system.cpu.supervisor.config.msr.set_interrupts(true);
        assert_eq!(
            hooks.msr_changed(&mut system).outcome,
            HookOutcome::Complete
        );
        system
            .cpu
            .supervisor
            .config
            .msr
            .set_data_addr_translation(true);
        assert_eq!(
            hooks.msr_changed(&mut system).outcome,
            HookOutcome::Complete
        );

        system
            .cpu
            .supervisor
            .config
            .msr
            .set_instr_addr_translation(true);
        let ir = hooks.msr_changed(&mut system);
        assert_eq!(ir.outcome, HookOutcome::Invalidated);
        assert_eq!(ir.invalidation, HookInvalidation::NONE);
        assert_eq!(hooks.current_generation(), AddressSpaceGeneration(2));

        system.cpu.supervisor.config.msr.set_user_mode(true);
        let user = hooks.msr_changed(&mut system);
        assert_eq!(user.invalidation, HookInvalidation::NONE);
        assert_eq!(hooks.current_generation(), AddressSpaceGeneration(3));
        system.cpu.supervisor.memory.ibat[0] = bat(0x8000_0002, 0x0000_0002);
        let ibat = hooks.instruction_bat_changed(&mut system);
        assert_eq!(ibat.outcome, HookOutcome::Invalidated);
        assert_eq!(
            ibat.invalidation.kind,
            HookInvalidationKind::AllInstructions
        );
        assert_eq!(hooks.current_generation(), AddressSpaceGeneration(4));
        system.cpu.supervisor.memory.sr[8] = 0x42;
        let segment = hooks.segment_register_changed(&system);
        assert_eq!(segment.invalidation, HookInvalidation::NONE);
        assert_eq!(hooks.current_generation(), AddressSpaceGeneration(5));
        system.cpu.supervisor.memory.sdr1 = 0x0001_0000;
        let sdr1 = hooks.sdr1_changed(&system);
        assert_eq!(sdr1.invalidation, HookInvalidation::NONE);
        assert_eq!(hooks.current_generation(), AddressSpaceGeneration(6));

        system.cpu.supervisor.memory.dbat[0] = bat(0x9000_0002, 0x0000_0002);
        assert_eq!(
            MachineRuntimeHooks::data_bat_changed(&mut system).outcome,
            HookOutcome::Complete
        );
        assert_eq!(hooks.current_generation(), AddressSpaceGeneration(6));
    }

    #[test]
    fn exceptions_and_cache_operations_return_rust_owned_invalidation_selectors() {
        let mut system = test_system();
        let mut hooks = MachineRuntimeHooks::new(&system.cpu);
        system
            .cpu
            .supervisor
            .config
            .msr
            .set_instr_addr_translation(true);
        assert_eq!(
            hooks.msr_changed(&mut system).outcome,
            HookOutcome::Invalidated
        );
        let translated_generation = hooks.current_generation();
        assert_eq!(translated_generation, AddressSpaceGeneration(2));

        system.cpu.pc = Address(0x8123_4560);
        system.cpu.supervisor.config.msr.set_exception_prefix(false);
        let raised = hooks.raise_exception_vector(&mut system, Exception::DSI as u32);
        assert_eq!(raised.outcome, HookOutcome::Invalidated);
        assert_eq!(raised.invalidation, HookInvalidation::NONE);
        assert_eq!(hooks.current_generation(), AddressSpaceGeneration(1));
        assert_eq!(system.cpu.pc, Address(0x300));
        assert_eq!(system.cpu.supervisor.exception.srr[0], 0x8123_4560);

        system
            .cpu
            .supervisor
            .config
            .msr
            .set_instr_addr_translation(true);
        let returned = hooks.msr_changed(&mut system);
        assert_eq!(returned.outcome, HookOutcome::Invalidated);
        assert_eq!(returned.invalidation, HookInvalidation::NONE);
        assert_eq!(hooks.current_generation(), translated_generation);
        assert_eq!(
            hooks
                .raise_exception_vector(&mut system, 0xdead_beef)
                .outcome,
            HookOutcome::Fault
        );

        system
            .cpu
            .supervisor
            .config
            .msr
            .set_instr_addr_translation(false);
        assert_eq!(
            hooks.msr_changed(&mut system).outcome,
            HookOutcome::Invalidated
        );

        let line = MachineRuntimeHooks::invalidate_instruction_cache_line(
            &mut system,
            Address(0x0000_201f),
        );
        assert_eq!(line.outcome, HookOutcome::Invalidated);
        assert_eq!(
            line.invalidation.kind,
            HookInvalidationKind::InstructionLine
        );
        assert_eq!(line.invalidation.effective, 0x2000);
        assert_ne!(line.invalidation.flags & INVALIDATION_HAS_PHYSICAL, 0);

        let block = CachedBlock::new(
            hooks.current_generation(),
            Address(0x8000_1000),
            17,
            4,
            1,
            1,
            0,
            &[PhysicalRange {
                start: 0x2000,
                len: 4,
            }],
            &[InstructionPageDependency {
                effective: Address(0x8000_1000),
                physical: Address(0x2000),
            }],
        )
        .unwrap();
        assert!(line.invalidation.selects(&block));
        assert_eq!(block.table_retirement().table_slot, 17);

        let tlbie = MachineRuntimeHooks::tlbie(&mut system, Address(0x8000_1000));
        assert_eq!(tlbie.outcome, HookOutcome::Invalidated);
        assert_eq!(
            tlbie.invalidation.kind,
            HookInvalidationKind::TranslationSet
        );
        assert!(tlbie.invalidation.selects(&block));
        assert_eq!(
            MachineRuntimeHooks::tlbsync(&mut system).outcome,
            HookOutcome::Complete
        );
        assert!(
            MachineRuntimeHooks::clear_instruction_cache()
                .invalidation
                .selects(&block)
        );
    }

    #[test]
    fn namespace_capacity_evicts_only_the_exact_lru_generation() {
        let mut system = test_system();
        let mut hooks = MachineRuntimeHooks::new(&system.cpu);

        for signature in 1..crate::runtime::INSTRUCTION_ADDRESS_SPACE_NAMESPACE_CAPACITY as u32 {
            system.cpu.supervisor.memory.sr[0] = signature;
            let transition = hooks.segment_register_changed(&system);
            assert_eq!(transition.outcome, HookOutcome::Invalidated);
            assert_eq!(transition.invalidation, HookInvalidation::NONE);
        }
        system.cpu.supervisor.memory.sr[0] =
            crate::runtime::INSTRUCTION_ADDRESS_SPACE_NAMESPACE_CAPACITY as u32;
        let evicted = hooks.segment_register_changed(&system);
        assert_eq!(evicted.outcome, HookOutcome::Invalidated);
        assert_eq!(
            evicted.invalidation.kind,
            HookInvalidationKind::AddressSpace
        );
        assert_eq!(
            evicted.invalidation.generation(),
            Some(AddressSpaceGeneration(1))
        );

        let retired = CachedBlock::new(
            AddressSpaceGeneration(1),
            Address(0x1000),
            3,
            4,
            1,
            1,
            0,
            &[PhysicalRange {
                start: 0x1000,
                len: 4,
            }],
            &[],
        )
        .unwrap();
        let retained = CachedBlock::new(
            AddressSpaceGeneration(2),
            Address(0x1000),
            4,
            4,
            1,
            1,
            0,
            &[PhysicalRange {
                start: 0x1000,
                len: 4,
            }],
            &[],
        )
        .unwrap();
        assert!(evicted.invalidation.selects(&retired));
        assert!(!evicted.invalidation.selects(&retained));
    }

    #[test]
    fn locked_cache_dma_ports_bounded_alias_wrap_and_reservation_semantics() {
        let mut system = test_system();
        let source: Vec<u8> = (0..64).map(|byte| byte ^ 0x5a).collect();
        system.mem.ram_mut()[0x100..0x140].copy_from_slice(&source);
        system.cpu.reservation.reserve(Address(0xe000_0000));
        system.cpu.supervisor.config.dma.upper = gekko::DmaConfigUpper::from_bits(0x8000_0100);
        // Trigger + flush + two 32-byte blocks + RAM-to-cache, ending one line before wrap.
        system.cpu.supervisor.config.dma.lower =
            gekko::DmaConfigLower::from_bits(0xe000_3fe0 | 0x1b);

        assert_eq!(
            MachineRuntimeHooks::locked_cache_dma(&mut system).outcome,
            HookOutcome::Complete
        );
        assert_eq!(&system.mem.l2c()[0x3fe0..], &source[..32]);
        assert_eq!(&system.mem.l2c()[..32], &source[32..]);
        assert!(!system.cpu.reservation.is_valid());
        assert!(!system.cpu.supervisor.config.dma.lower.trigger());
        assert!(!system.cpu.supervisor.config.dma.lower.flush());

        let replacement: Vec<u8> = (0..64).map(|byte| byte ^ 0xa5).collect();
        system.mem.l2c_mut()[0x3fe0..].copy_from_slice(&replacement[..32]);
        system.mem.l2c_mut()[..32].copy_from_slice(&replacement[32..]);
        system.cpu.reservation.reserve(Address(0x0000_0100));
        system.cpu.supervisor.config.dma.lower =
            gekko::DmaConfigLower::from_bits(0xe000_3fe0 | 0x0b);
        assert_eq!(
            MachineRuntimeHooks::locked_cache_dma(&mut system).outcome,
            HookOutcome::Complete
        );
        assert_eq!(&system.mem.ram()[0x100..0x140], &replacement);
        assert!(!system.cpu.reservation.is_valid());

        // A guest-controlled unbacked MEM1 range is acknowledged without slicing or panicking.
        system.mem.l2c_mut()[..64].fill(0x77);
        system.cpu.supervisor.config.dma.upper = gekko::DmaConfigUpper::from_bits(0x0200_0000);
        system.cpu.supervisor.config.dma.lower =
            gekko::DmaConfigLower::from_bits(0xe000_0000 | 0x1b);
        assert_eq!(
            MachineRuntimeHooks::locked_cache_dma(&mut system).outcome,
            HookOutcome::Complete
        );
        assert_eq!(&system.mem.l2c()[..64], &[0x77; 64]);
        assert!(!system.cpu.supervisor.config.dma.lower.trigger());
        assert!(!system.cpu.supervisor.config.dma.lower.flush());

        system.cpu.supervisor.config.dma.lower = gekko::DmaConfigLower::from_bits(1);
        assert_eq!(
            MachineRuntimeHooks::locked_cache_dma(&mut system).outcome,
            HookOutcome::Complete
        );
        assert!(!system.cpu.supervisor.config.dma.lower.flush());
    }
}
