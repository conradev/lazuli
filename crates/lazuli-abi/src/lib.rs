//! Stable records shared by Lazuli's WebAssembly machine and its browser adapter.
//!
//! This crate deliberately contains no emulator policy. It only describes why the Rust machine
//! returned to its host and the request/completion records needed at cold compilation and
//! asynchronous browser boundaries. Every host-written tag remains a raw `u32` in shared memory;
//! callers must use the checked accessors before turning one into a Rust enum.

#![no_std]

use core::cmp::Ordering;
use core::fmt;
use core::mem::size_of;

/// Current version of every record in this crate.
pub const ABI_VERSION: u32 = 1;

/// Common prefix for every versioned shared-memory record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct RecordHeader {
    pub abi_version: u32,
    pub byte_len: u32,
}

impl RecordHeader {
    #[must_use]
    pub const fn for_record<T>() -> Self {
        Self {
            abi_version: ABI_VERSION,
            byte_len: size_of::<T>() as u32,
        }
    }

    /// Returns whether this header contains at least the fields known by `T`.
    #[must_use]
    pub const fn supports<T>(self) -> bool {
        self.abi_version == ABI_VERSION && self.byte_len >= size_of::<T>() as u32
    }
}

/// A byte offset in the one shared WebAssembly linear memory.
///
/// This is always 32-bit even when ABI tooling runs on a 64-bit native host.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(transparent)]
pub struct SharedPtr(pub u32);

impl SharedPtr {
    pub const NULL: Self = Self(0);

    #[must_use]
    pub const fn is_null(self) -> bool {
        self.0 == 0
    }
}

/// A bounded byte range in shared WebAssembly linear memory.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct SharedSlice {
    pub ptr: SharedPtr,
    pub len: u32,
}

/// One circular 32-bit physical-address interval used to retire translated code precisely.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct PhysicalRange {
    pub start: u32,
    pub len: u32,
}

impl PhysicalRange {
    #[must_use]
    pub const fn contains(self, address: u32) -> bool {
        self.len != 0 && address.wrapping_sub(self.start) < self.len
    }

    /// Tests circular intervals without overflowing at the 4 GiB boundary.
    #[must_use]
    pub const fn overlaps(self, other: Self) -> bool {
        self.len != 0
            && other.len != 0
            && (self.contains(other.start) || other.contains(self.start))
    }
}

impl SharedSlice {
    pub const EMPTY: Self = Self {
        ptr: SharedPtr::NULL,
        len: 0,
    };

    #[must_use]
    pub const fn checked_end(self) -> Option<u32> {
        self.ptr.0.checked_add(self.len)
    }
}

/// A raw ABI tag that does not name a value known by this version of the runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnknownDiscriminant(pub u32);

impl fmt::Display for UnknownDiscriminant {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown ABI discriminant {}", self.0)
    }
}

macro_rules! checked_abi_enum {
    (
        $(#[$meta:meta])*
        pub enum $name:ident {
            $($variant:ident = $value:expr),+ $(,)?
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        #[repr(u32)]
        pub enum $name {
            $($variant = $value),+
        }

        impl TryFrom<u32> for $name {
            type Error = UnknownDiscriminant;

            fn try_from(value: u32) -> Result<Self, Self::Error> {
                match value {
                    $($value => Ok(Self::$variant),)+
                    value => Err(UnknownDiscriminant(value)),
                }
            }
        }

        impl From<$name> for u32 {
            fn from(value: $name) -> Self {
                value as Self
            }
        }
    };
}

checked_abi_enum! {
    /// Why a long-running Rust/Wasm machine slice returned to the browser adapter.
    pub enum RunReason {
        BudgetExhausted = 0,
        CompileRequired = 1,
        HostRequest = 2,
        Halted = 3,
        Breakpoint = 4,
        Fault = 5,
        InvalidState = 6,
    }
}

checked_abi_enum! {
    /// Result markers returned by the Rust-authorized resident-block self-installer.
    ///
    /// `Authorized` is returned only by the begin step. `Committed` is returned only after Rust
    /// has accepted the exact table occupant and published its slot/cache records. `Cancelled`
    /// acknowledges exact-identity recovery after a browser compile/instantiate/install failure.
    /// Every failure value leaves the dispatcher metadata unpublished.
    pub enum ResidentInstallStatus {
        NoPendingRequest = 0,
        IdentityMismatch = 1,
        AddressSpaceChanged = 2,
        InvalidPhase = 3,
        TableUnavailable = 4,
        Authorized = 0x4c5a_4155,
        Cancelled = 0x4c5a_4341,
        Committed = 0x4c5a_434d,
    }
}

checked_abi_enum! {
    /// An asynchronous operation that cannot execute inside WebAssembly itself.
    pub enum HostRequestKind {
        DiscRead = 0,
        RenderSubmit = 1,
        AudioSubmit = 2,
        PersistentRead = 3,
        PersistentWrite = 4,
    }
}

checked_abi_enum! {
    /// Result of compiling, instantiating, and placing Rust-issued Wasm bytes into a table slot.
    pub enum BlockInstallStatus {
        Installed = 0,
        CompileError = 1,
        InstantiateError = 2,
        TableError = 3,
        Rejected = 4,
    }
}

checked_abi_enum! {
    /// Host-reported result of an asynchronous request.
    pub enum HostCompletionStatus {
        Ok = 0,
        Unsupported = 1,
        InvalidRequest = 2,
        IoError = 3,
        EndOfFile = 4,
        Cancelled = 5,
        HostError = 6,
    }
}

checked_abi_enum! {
    /// Renderer terminal whose effects a [`RenderReceipt`] acknowledges.
    ///
    /// These values intentionally match the canonical LZGX terminal codes, but the ABI keeps its
    /// own checked vocabulary so neither the browser nor this host-neutral crate needs to decode a
    /// graphics packet.
    pub enum RenderReceiptKind {
        TextureCopy = 1,
        XfbCopy = 2,
        EfbPeek = 3,
        ViPresent = 4,
    }
}

checked_abi_enum! {
    /// Result of applying one Rust-authored VI field selection at the renderer.
    pub enum RenderPresentationStatus {
        Rejected = 0,
        Staged = 1,
        Presented = 2,
    }
}

checked_abi_enum! {
    /// Rust-selected VI presentation mode.
    pub enum ViPresentationMode {
        Progressive = 0,
        SingleField = 1,
        Interlaced = 2,
    }
}

checked_abi_enum! {
    /// Field parity used by one VI presentation request.
    pub enum ViFieldParity {
        Top = 0,
        Bottom = 1,
    }
}

checked_abi_enum! {
    /// Renderer-authored outcome inside an authenticated render completion.
    pub enum RenderReceiptStatus {
        Completed = 0,
        Rejected = 1,
        DeviceLost = 2,
        HostError = 3,
    }
}

/// [`RenderReceipt::efb_value`] contains the scalar result of an EFB peek.
pub const RENDER_RECEIPT_HAS_EFB_VALUE: u32 = 1;
/// The presentation epoch, extent, and serial fields in [`RenderReceipt`] are present.
pub const RENDER_RECEIPT_HAS_PRESENTATION: u32 = 1 << 1;
/// Every flag understood by this ABI version.
pub const RENDER_RECEIPT_KNOWN_FLAGS: u32 =
    RENDER_RECEIPT_HAS_EFB_VALUE | RENDER_RECEIPT_HAS_PRESENTATION;
/// This VI field is expected to complete its progressive/single/interlaced presentation unit.
pub const VI_PRESENTATION_PAIR_COMPLETING: u32 = 1;
/// A [`HostRequestKind::RenderSubmit`] address points to a [`ViPresentationRequest`] rather than
/// an LZGX packet. All other render-submit flags remain zero in this ABI version.
pub const RENDER_REQUEST_VI_PRESENT: u32 = 1;

/// Result of one Rust/Wasm machine run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct RunOutcome {
    pub header: RecordHeader,
    /// Raw [`RunReason`] discriminant. Decode with [`Self::reason`].
    pub reason_raw: u32,
    /// Reason-specific integer detail; it never transfers machine ownership to the host.
    pub detail: u32,
    pub executed_cycles_lo: u32,
    pub executed_cycles_hi: u32,
    pub executed_instructions_lo: u32,
    pub executed_instructions_hi: u32,
    /// Points at a [`CompileRequest`] or [`HostRequest`] when the reason requires one.
    pub request_ptr: SharedPtr,
    pub reserved: u32,
}

/// Prefix shared by the resident dispatcher and every lowered PPC runtime hook.
///
/// The dispatcher publishes the completed-cycle prefix before entering a block.  A lowered block
/// publishes the current instruction's start-cycle offset immediately before a semantic hook.
/// Rust hooks combine the two values to observe the exact in-slice machine time and set
/// `exit_requested` whenever the outer scheduler must regain control.  The record is owned by the
/// Rust browser machine; the browser adapter never allocates or writes it.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct ResidentControl {
    pub slice_cycle_prefix: u32,
    pub exit_requested: u32,
    pub instruction_cycle_offset: u32,
}

/// Complete Rust-owned context window passed to every resident PPC block.
pub const RESIDENT_CONTEXT_BYTES: usize = 0x1000;
/// Start of the explicit CLIF stack-scratch window relative to the context pointer.
pub const RESIDENT_STACK_SCRATCH_OFFSET: usize = 0x0800;
/// Size of the explicit CLIF stack-scratch window.
pub const RESIDENT_STACK_SCRATCH_BYTES: usize = 0x0800;

const _: () =
    assert!(RESIDENT_STACK_SCRATCH_OFFSET + RESIDENT_STACK_SCRATCH_BYTES == RESIDENT_CONTEXT_BYTES);
const _: () = assert!(size_of::<ResidentControl>() <= RESIDENT_STACK_SCRATCH_OFFSET);

impl ResidentControl {
    #[must_use]
    pub const fn exact_hook_cycle(self) -> u64 {
        self.slice_cycle_prefix as u64 + self.instruction_cycle_offset as u64
    }

    #[must_use]
    pub const fn should_exit(self) -> bool {
        self.exit_requested != 0
    }

    pub fn request_exit(&mut self) {
        self.exit_requested = 1;
    }

    pub fn clear_for_slice(&mut self) {
        *self = Self {
            slice_cycle_prefix: 0,
            exit_requested: 0,
            instruction_cycle_offset: 0,
        };
    }
}

impl RunOutcome {
    #[must_use]
    pub const fn new(reason: RunReason) -> Self {
        Self {
            header: RecordHeader::for_record::<Self>(),
            reason_raw: reason as u32,
            detail: 0,
            executed_cycles_lo: 0,
            executed_cycles_hi: 0,
            executed_instructions_lo: 0,
            executed_instructions_hi: 0,
            request_ptr: SharedPtr::NULL,
            reserved: 0,
        }
    }

    pub fn reason(self) -> Result<RunReason, UnknownDiscriminant> {
        RunReason::try_from(self.reason_raw)
    }

    #[must_use]
    pub const fn executed_cycles(self) -> u64 {
        self.executed_cycles_lo as u64 | ((self.executed_cycles_hi as u64) << 32)
    }

    #[must_use]
    pub const fn executed_instructions(self) -> u64 {
        self.executed_instructions_lo as u64 | ((self.executed_instructions_hi as u64) << 32)
    }
}

/// Cold-compiler request emitted by the Rust machine after a dispatch-table miss.
///
/// `module` is the exact opaque Wasm binary produced by Rust. The host may only compile,
/// instantiate, and invoke that module's zero-argument self-installer. The module itself owns its
/// typed table write; the host receives no function-placement or emulator-policy authority.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct CompileRequest {
    pub header: RecordHeader,
    pub request_id: u32,
    /// Dispatch-table slot allocated by Rust and embedded into the self-installer.
    pub table_slot: u32,
    /// Rust-issued slot identity, split to keep the record uniformly 32-bit.
    pub slot_nonce_lo: u32,
    pub slot_nonce_hi: u32,
    /// Instruction address-space generation at request time.
    pub address_space_generation_lo: u32,
    pub address_space_generation_hi: u32,
    /// One-use authority embedded in the exact Rust-authored block module.
    pub install_token_lo: u32,
    pub install_token_hi: u32,
    /// Exact Rust-issued WebAssembly module bytes in shared memory.
    pub module: SharedSlice,
    /// SHA-256 of `module`, encoded as eight big-endian fixed-width words for ABI stability.
    pub module_sha256: [u32; 8],
    pub reserved: u32,
}

impl CompileRequest {
    #[must_use]
    pub const fn slot_nonce(self) -> u64 {
        self.slot_nonce_lo as u64 | ((self.slot_nonce_hi as u64) << 32)
    }

    #[must_use]
    pub const fn address_space_generation(self) -> u64 {
        self.address_space_generation_lo as u64 | ((self.address_space_generation_hi as u64) << 32)
    }

    #[must_use]
    pub const fn install_token(self) -> u64 {
        self.install_token_lo as u64 | ((self.install_token_hi as u64) << 32)
    }

    #[must_use]
    pub const fn install_identity(self) -> ResidentBlockInstallIdentity {
        ResidentBlockInstallIdentity {
            request_id: self.request_id,
            table_slot: self.table_slot,
            slot_nonce_lo: self.slot_nonce_lo,
            slot_nonce_hi: self.slot_nonce_hi,
            address_space_generation_lo: self.address_space_generation_lo,
            address_space_generation_hi: self.address_space_generation_hi,
            install_token_lo: self.install_token_lo,
            install_token_hi: self.install_token_hi,
        }
    }

    /// Rejects null, empty, wrapping, or nonzero-reserved source records before the host sees one.
    #[must_use]
    pub const fn has_valid_source(self) -> bool {
        self.header.supports::<Self>()
            && !self.module.ptr.is_null()
            && self.module.len != 0
            && self.module.checked_end().is_some()
            && self.reserved == 0
    }
}

/// Exact one-use authority embedded in a Rust-authored resident block module.
///
/// The browser never constructs this record. Rust allocates it before final module lowering, then
/// the generated module passes these constants to the begin/commit exports around its own typed
/// `table.set(ref.func run)`. A module delayed past slot reuse therefore carries a stale nonce and
/// token and is rejected before it can touch the table.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct ResidentBlockInstallIdentity {
    pub request_id: u32,
    pub table_slot: u32,
    pub slot_nonce_lo: u32,
    pub slot_nonce_hi: u32,
    pub address_space_generation_lo: u32,
    pub address_space_generation_hi: u32,
    pub install_token_lo: u32,
    pub install_token_hi: u32,
}

impl ResidentBlockInstallIdentity {
    #[must_use]
    pub const fn slot_nonce(self) -> u64 {
        self.slot_nonce_lo as u64 | ((self.slot_nonce_hi as u64) << 32)
    }

    #[must_use]
    pub const fn address_space_generation(self) -> u64 {
        self.address_space_generation_lo as u64 | ((self.address_space_generation_hi as u64) << 32)
    }

    #[must_use]
    pub const fn install_token(self) -> u64 {
        self.install_token_lo as u64 | ((self.install_token_hi as u64) << 32)
    }

    #[must_use]
    pub const fn matches_request(self, request: &CompileRequest) -> bool {
        self.request_id == request.request_id
            && self.table_slot == request.table_slot
            && self.slot_nonce_lo == request.slot_nonce_lo
            && self.slot_nonce_hi == request.slot_nonce_hi
            && self.address_space_generation_lo == request.address_space_generation_lo
            && self.address_space_generation_hi == request.address_space_generation_hi
            && self.install_token_lo == request.install_token_lo
            && self.install_token_hi == request.install_token_hi
    }
}

/// Transitional receipt supplied when a browser cannot run the resident self-installer.
///
/// The receipt deliberately contains no block ranges, guest addresses, instruction counts, or
/// cache metadata. Rust retains all semantic metadata in its pending request and accepts only an
/// exact identity plus a checked status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct BlockInstall {
    pub header: RecordHeader,
    pub request_id: u32,
    pub table_index: u32,
    pub slot_nonce_lo: u32,
    pub slot_nonce_hi: u32,
    pub address_space_generation_lo: u32,
    pub address_space_generation_hi: u32,
    pub install_token_lo: u32,
    pub install_token_hi: u32,
    /// Raw [`BlockInstallStatus`] discriminant. Decode with [`Self::status`].
    pub status_raw: u32,
    pub reserved: u32,
}

impl BlockInstall {
    pub fn status(self) -> Result<BlockInstallStatus, UnknownDiscriminant> {
        BlockInstallStatus::try_from(self.status_raw)
    }

    #[must_use]
    pub const fn slot_nonce(self) -> u64 {
        self.slot_nonce_lo as u64 | ((self.slot_nonce_hi as u64) << 32)
    }

    #[must_use]
    pub const fn address_space_generation(self) -> u64 {
        self.address_space_generation_lo as u64 | ((self.address_space_generation_hi as u64) << 32)
    }

    /// Checks every Rust-issued identity field that a transitional receipt must echo unchanged.
    #[must_use]
    pub const fn matches_request_identity(&self, request: &CompileRequest) -> bool {
        self.header.supports::<Self>()
            && request.header.supports::<CompileRequest>()
            && self.request_id == request.request_id
            && self.table_index == request.table_slot
            && self.slot_nonce_lo == request.slot_nonce_lo
            && self.slot_nonce_hi == request.slot_nonce_hi
            && self.address_space_generation_lo == request.address_space_generation_lo
            && self.address_space_generation_hi == request.address_space_generation_hi
            && self.install_token_lo == request.install_token_lo
            && self.install_token_hi == request.install_token_hi
            && self.reserved == 0
    }

    /// Accepts only a successful receipt for the exact outstanding Rust-issued request.
    #[must_use]
    pub fn is_installed_for(&self, request: &CompileRequest) -> bool {
        self.matches_request_identity(request) && self.status() == Ok(BlockInstallStatus::Installed)
    }
}

/// Request for an asynchronous browser capability.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct HostRequest {
    pub header: RecordHeader,
    pub request_id: u32,
    /// Rust-issued request identity used to reject late or duplicate completions.
    pub request_nonce_lo: u32,
    pub request_nonce_hi: u32,
    /// Raw [`HostRequestKind`] discriminant. Decode with [`Self::kind`].
    pub kind_raw: u32,
    pub flags: u32,
    pub address: u32,
    pub length: u32,
    /// Exact Rust-issued staging buffer. The host may not redirect a completion elsewhere.
    pub payload: SharedSlice,
    pub arg0: u32,
    pub arg1: u32,
}

impl HostRequest {
    pub fn kind(self) -> Result<HostRequestKind, UnknownDiscriminant> {
        HostRequestKind::try_from(self.kind_raw)
    }

    #[must_use]
    pub const fn request_nonce(self) -> u64 {
        self.request_nonce_lo as u64 | ((self.request_nonce_hi as u64) << 32)
    }
}

/// Completion delivered exactly once for a previously emitted [`HostRequest`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct HostCompletion {
    pub header: RecordHeader,
    pub request_id: u32,
    pub request_nonce_lo: u32,
    pub request_nonce_hi: u32,
    /// Raw [`HostCompletionStatus`] discriminant. Decode with [`Self::status`].
    pub status_raw: u32,
    /// Number of initialized bytes in the request's Rust-issued staging buffer.
    pub filled_len: u32,
    pub reserved: u32,
    pub value_lo: u32,
    pub value_hi: u32,
}

impl HostCompletion {
    pub fn status(self) -> Result<HostCompletionStatus, UnknownDiscriminant> {
        HostCompletionStatus::try_from(self.status_raw)
    }

    #[must_use]
    pub const fn value(self) -> u64 {
        self.value_lo as u64 | ((self.value_hi as u64) << 32)
    }

    /// Checks the complete Rust-issued identity before a machine applies a host receipt.
    #[must_use]
    pub const fn matches_request_identity(&self, request: &HostRequest) -> bool {
        self.header.supports::<Self>()
            && request.header.supports::<HostRequest>()
            && self.request_id == request.request_id
            && self.request_nonce_lo == request.request_nonce_lo
            && self.request_nonce_hi == request.request_nonce_hi
    }

    /// Returns the completed prefix of the exact Rust-issued staging buffer.
    ///
    /// No pointer is accepted from the host. Invalid identity, reserved bits, or an oversized
    /// byte count fail closed.
    #[must_use]
    pub const fn checked_filled_slice(&self, request: &HostRequest) -> Option<SharedSlice> {
        if !self.matches_request_identity(request)
            || self.reserved != 0
            || self.filled_len > request.payload.len
        {
            return None;
        }
        Some(SharedSlice {
            ptr: request.payload.ptr,
            len: self.filled_len,
        })
    }
}

/// Immutable Rust-authored VI presentation input transported as an opaque render payload.
///
/// The browser adapter may relay these integers to the renderer, but cannot choose or amend them;
/// the Rust machine retains an exact private copy and authenticates the payload digest again at
/// completion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct ViPresentationRequest {
    pub header: RecordHeader,
    pub sequence_lo: u32,
    pub sequence_hi: u32,
    pub selected_address: u32,
    pub expected_generation: u32,
    pub selected_row: u32,
    /// Raw [`ViPresentationMode`] discriminant. Decode with [`Self::mode`].
    pub mode_raw: u32,
    /// Raw [`ViFieldParity`] discriminant. Decode with [`Self::parity`].
    pub parity_raw: u32,
    pub pair_epoch: u32,
    pub output_width: u32,
    pub output_height: u32,
    pub field_stride_bytes: u32,
    pub field_height: u32,
    pub row_repeat: u32,
    pub flags: u32,
    pub reserved: [u32; 4],
}

impl ViPresentationRequest {
    pub const BYTE_LEN: usize = size_of::<Self>();

    #[allow(clippy::too_many_arguments)]
    #[must_use]
    pub const fn new(
        sequence: u64,
        selected_address: u32,
        expected_generation: u32,
        selected_row: u32,
        mode: ViPresentationMode,
        parity: ViFieldParity,
        pair_epoch: u32,
        output_width: u32,
        output_height: u32,
        field_stride_bytes: u32,
        field_height: u32,
        row_repeat: u32,
        pair_completing: bool,
    ) -> Self {
        Self {
            header: RecordHeader::for_record::<Self>(),
            sequence_lo: sequence as u32,
            sequence_hi: (sequence >> 32) as u32,
            selected_address,
            expected_generation,
            selected_row,
            mode_raw: mode as u32,
            parity_raw: parity as u32,
            pair_epoch,
            output_width,
            output_height,
            field_stride_bytes,
            field_height,
            row_repeat,
            flags: if pair_completing {
                VI_PRESENTATION_PAIR_COMPLETING
            } else {
                0
            },
            reserved: [0; 4],
        }
    }

    #[must_use]
    pub const fn sequence(self) -> u64 {
        self.sequence_lo as u64 | ((self.sequence_hi as u64) << 32)
    }

    pub fn mode(self) -> Result<ViPresentationMode, UnknownDiscriminant> {
        ViPresentationMode::try_from(self.mode_raw)
    }

    pub fn parity(self) -> Result<ViFieldParity, UnknownDiscriminant> {
        ViFieldParity::try_from(self.parity_raw)
    }

    #[must_use]
    pub const fn pair_completing(self) -> bool {
        self.flags & VI_PRESENTATION_PAIR_COMPLETING != 0
    }

    #[must_use]
    pub fn has_canonical_shape(self) -> bool {
        self.header == RecordHeader::for_record::<Self>()
            && self.mode().is_ok()
            && self.parity().is_ok()
            && self.flags & !VI_PRESENTATION_PAIR_COMPLETING == 0
            && self.expected_generation != 0
            && self.pair_epoch != 0
            && self.output_width != 0
            && self.output_height != 0
            && self.field_stride_bytes != 0
            && self.field_height != 0
            && self.row_repeat != 0
            && self.reserved == [0; 4]
    }

    /// Decodes one little-endian VI payload without borrowing or trusting host alignment.
    #[must_use]
    pub fn decode_le(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < Self::BYTE_LEN {
            return None;
        }
        let word = |index: usize| {
            let offset = index * size_of::<u32>();
            u32::from_le_bytes([
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                bytes[offset + 3],
            ])
        };
        Some(Self {
            header: RecordHeader {
                abi_version: word(0),
                byte_len: word(1),
            },
            sequence_lo: word(2),
            sequence_hi: word(3),
            selected_address: word(4),
            expected_generation: word(5),
            selected_row: word(6),
            mode_raw: word(7),
            parity_raw: word(8),
            pair_epoch: word(9),
            output_width: word(10),
            output_height: word(11),
            field_stride_bytes: word(12),
            field_height: word(13),
            row_repeat: word(14),
            flags: word(15),
            reserved: [word(16), word(17), word(18), word(19)],
        })
    }

    /// Encodes the exact little-endian request payload without trusting host alignment.
    pub fn encode_le(self, bytes: &mut [u8]) -> bool {
        if bytes.len() < Self::BYTE_LEN {
            return false;
        }
        let words = [
            self.header.abi_version,
            self.header.byte_len,
            self.sequence_lo,
            self.sequence_hi,
            self.selected_address,
            self.expected_generation,
            self.selected_row,
            self.mode_raw,
            self.parity_raw,
            self.pair_epoch,
            self.output_width,
            self.output_height,
            self.field_stride_bytes,
            self.field_height,
            self.row_repeat,
            self.flags,
            self.reserved[0],
            self.reserved[1],
            self.reserved[2],
            self.reserved[3],
        ];
        for (destination, word) in bytes.chunks_exact_mut(size_of::<u32>()).zip(words) {
            destination.copy_from_slice(&word.to_le_bytes());
        }
        true
    }
}

/// Integer-only renderer receipt written into the exact staging slice issued by Rust.
///
/// A successful texture copy appends `payload_len` opaque materialized bytes immediately after
/// this fixed record. XFB, EFB-peek, and VI-presentation receipts have no appended payload. The
/// host never supplies a pointer, destination, or other machine commit metadata: Rust retains
/// those privately with the pending request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct RenderReceipt {
    pub header: RecordHeader,
    pub sequence_lo: u32,
    pub sequence_hi: u32,
    /// Raw [`RenderReceiptKind`] discriminant. Decode with [`Self::kind`].
    pub kind_raw: u32,
    /// Raw [`RenderReceiptStatus`] discriminant. Decode with [`Self::status`].
    pub status_raw: u32,
    /// Exact Rust-issued terminal generation echoed by the renderer.
    pub generation: u32,
    pub flags: u32,
    /// Number of initialized bytes immediately following this fixed record.
    pub payload_len: u32,
    /// Meaningful only when [`RENDER_RECEIPT_HAS_EFB_VALUE`] is set.
    pub efb_value: u32,
    /// Meaningful only when [`RENDER_RECEIPT_HAS_PRESENTATION`] is set.
    pub presentation_epoch: u32,
    pub presentation_width: u32,
    pub presentation_height: u32,
    pub presentation_serial_lo: u32,
    pub presentation_serial_hi: u32,
    /// Raw [`RenderPresentationStatus`] discriminant when presentation fields are present.
    pub presentation_status_raw: u32,
    pub reserved: [u32; 4],
}

impl RenderReceipt {
    /// Fixed byte length of the integer record, excluding an optional trailing payload.
    pub const BYTE_LEN: usize = size_of::<Self>();

    #[must_use]
    pub const fn new(
        sequence: u64,
        kind: RenderReceiptKind,
        status: RenderReceiptStatus,
        generation: u32,
    ) -> Self {
        Self {
            header: RecordHeader::for_record::<Self>(),
            sequence_lo: sequence as u32,
            sequence_hi: (sequence >> 32) as u32,
            kind_raw: kind as u32,
            status_raw: status as u32,
            generation,
            flags: 0,
            payload_len: 0,
            efb_value: 0,
            presentation_epoch: 0,
            presentation_width: 0,
            presentation_height: 0,
            presentation_serial_lo: 0,
            presentation_serial_hi: 0,
            presentation_status_raw: 0,
            reserved: [0; 4],
        }
    }

    #[must_use]
    pub const fn sequence(self) -> u64 {
        self.sequence_lo as u64 | ((self.sequence_hi as u64) << 32)
    }

    pub fn kind(self) -> Result<RenderReceiptKind, UnknownDiscriminant> {
        RenderReceiptKind::try_from(self.kind_raw)
    }

    pub fn status(self) -> Result<RenderReceiptStatus, UnknownDiscriminant> {
        RenderReceiptStatus::try_from(self.status_raw)
    }

    #[must_use]
    pub const fn presentation_serial(self) -> u64 {
        self.presentation_serial_lo as u64 | ((self.presentation_serial_hi as u64) << 32)
    }

    pub fn presentation_status(self) -> Result<RenderPresentationStatus, UnknownDiscriminant> {
        RenderPresentationStatus::try_from(self.presentation_status_raw)
    }

    /// Checks the exact record version, checked enums, known flags, canonical absent optionals,
    /// and zero reserved words. Request-specific semantics remain private to the Rust machine.
    #[must_use]
    pub fn has_canonical_shape(self) -> bool {
        self.header == RecordHeader::for_record::<Self>()
            && self.kind().is_ok()
            && self.status().is_ok()
            && self.flags & !RENDER_RECEIPT_KNOWN_FLAGS == 0
            && (self.flags & RENDER_RECEIPT_HAS_EFB_VALUE != 0 || self.efb_value == 0)
            && (self.flags & RENDER_RECEIPT_HAS_PRESENTATION != 0
                || (self.presentation_epoch == 0
                    && self.presentation_width == 0
                    && self.presentation_height == 0
                    && self.presentation_serial_lo == 0
                    && self.presentation_serial_hi == 0
                    && self.presentation_status_raw == 0))
            && (self.flags & RENDER_RECEIPT_HAS_PRESENTATION == 0
                || self.presentation_status().is_ok())
            && self.reserved == [0; 4]
    }

    /// Decodes one little-endian fixed record without borrowing or trusting host alignment.
    #[must_use]
    pub fn decode_le(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < Self::BYTE_LEN {
            return None;
        }
        let word = |index: usize| {
            let offset = index * size_of::<u32>();
            u32::from_le_bytes([
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                bytes[offset + 3],
            ])
        };
        Some(Self {
            header: RecordHeader {
                abi_version: word(0),
                byte_len: word(1),
            },
            sequence_lo: word(2),
            sequence_hi: word(3),
            kind_raw: word(4),
            status_raw: word(5),
            generation: word(6),
            flags: word(7),
            payload_len: word(8),
            efb_value: word(9),
            presentation_epoch: word(10),
            presentation_width: word(11),
            presentation_height: word(12),
            presentation_serial_lo: word(13),
            presentation_serial_hi: word(14),
            presentation_status_raw: word(15),
            reserved: [word(16), word(17), word(18), word(19)],
        })
    }

    /// Encodes one fixed record in the little-endian WebAssembly memory representation.
    pub fn encode_le(self, bytes: &mut [u8]) -> bool {
        if bytes.len() < Self::BYTE_LEN {
            return false;
        }
        let words = [
            self.header.abi_version,
            self.header.byte_len,
            self.sequence_lo,
            self.sequence_hi,
            self.kind_raw,
            self.status_raw,
            self.generation,
            self.flags,
            self.payload_len,
            self.efb_value,
            self.presentation_epoch,
            self.presentation_width,
            self.presentation_height,
            self.presentation_serial_lo,
            self.presentation_serial_hi,
            self.presentation_status_raw,
            self.reserved[0],
            self.reserved[1],
            self.reserved[2],
            self.reserved[3],
        ];
        for (destination, word) in bytes.chunks_exact_mut(size_of::<u32>()).zip(words) {
            destination.copy_from_slice(&word.to_le_bytes());
        }
        true
    }
}

/// Fixed little-endian words for one unsigned 64-bit evidence value.
///
/// Keeping the split explicit makes the record layout identical on native test hosts and wasm32.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct EvidenceU64 {
    pub lo: u32,
    pub hi: u32,
}

impl EvidenceU64 {
    #[must_use]
    pub const fn new(value: u64) -> Self {
        Self {
            lo: value as u32,
            hi: (value >> 32) as u32,
        }
    }

    #[must_use]
    pub const fn get(self) -> u64 {
        self.lo as u64 | ((self.hi as u64) << 32)
    }
}

impl Ord for EvidenceU64 {
    fn cmp(&self, other: &Self) -> Ordering {
        self.hi.cmp(&other.hi).then_with(|| self.lo.cmp(&other.lo))
    }
}

impl PartialOrd for EvidenceU64 {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

checked_abi_enum! {
    /// Rust-owned SI phase that made one controller sample guest-visible.
    pub enum MachineSiPollSource {
        Periodic = 0,
        Direct = 1,
    }
}

checked_abi_enum! {
    /// Rust-owned lifecycle of one authenticated browser disc-boot attempt.
    pub enum MachineBootStatus {
        Idle = 0,
        Planning = 1,
        Loading = 2,
        Committed = 3,
        Failed = 4,
        Cancelled = 5,
    }
}

checked_abi_enum! {
    /// Stable Rust-owned terminal fault for one disc-boot attempt.
    pub enum MachineBootFault {
        None = 0,
        EpochExhausted = 1,
        Planning = 2,
        PlanningShortRead = 3,
        LoadStart = 4,
        Loading = 5,
        LoadingShortRead = 6,
    }
}

checked_abi_enum! {
    /// Authenticated logical image format retained by the committed Rust disc mapper.
    pub enum MachineDiscFormat {
        RawIso = 0,
        Ciso = 1,
    }
}

checked_abi_enum! {
    /// Current Rust-owned phase of one resident DI command.
    pub enum MachineDiLifecycleState {
        Idle = 0,
        StartPending = 1,
        AwaitingDeadline = 2,
        AwaitingHost = 3,
        ReadReady = 4,
    }
}

checked_abi_enum! {
    /// Address-free semantic kind of the current resident DI command.
    pub enum MachineDiCommandKind {
        None = 0,
        Inquiry = 1,
        ReadSector = 2,
        ReadDiscId = 3,
        Seek = 4,
        RequestError = 5,
        AudioStream = 6,
        AudioStatus = 7,
        StopMotor = 8,
        AudioConfig = 9,
        Unsupported = 10,
    }
}

/// Record tag for [`MachineEvidenceV1`] (`LZME`).
pub const MACHINE_EVIDENCE_V1_TAG: u32 = 0x4c5a_4d45;
/// The DSP LLE path was the machine's authenticated DSP implementation at this snapshot.
pub const MACHINE_EVIDENCE_DSP_LLE_VALID: u32 = 1;
/// The Rust machine has entered a terminal error state.
pub const MACHINE_EVIDENCE_TERMINAL_ERROR: u32 = 1 << 1;
/// [`MachineEvidenceV1::xfb_vi`] contains one authenticated XFB/VI/render chronology.
pub const MACHINE_EVIDENCE_HAS_XFB_VI: u32 = 1 << 2;
/// [`MachineEvidenceV1::si`] contains one Rust-authored guest-visible controller publication.
pub const MACHINE_EVIDENCE_HAS_SI_PUBLICATION: u32 = 1 << 3;
/// [`MachineEvidenceV1::boot`] contains an authenticated committed-disc identity.
pub const MACHINE_EVIDENCE_HAS_BOOT_IDENTITY: u32 = 1 << 4;
/// Every top-level evidence flag understood by this ABI version.
pub const MACHINE_EVIDENCE_KNOWN_FLAGS: u32 = MACHINE_EVIDENCE_DSP_LLE_VALID
    | MACHINE_EVIDENCE_TERMINAL_ERROR
    | MACHINE_EVIDENCE_HAS_XFB_VI
    | MACHINE_EVIDENCE_HAS_SI_PUBLICATION
    | MACHINE_EVIDENCE_HAS_BOOT_IDENTITY;

/// This VI request completes its progressive, single-field, or interlaced presentation unit.
pub const MACHINE_XFB_VI_PAIR_COMPLETING: u32 = 1;
/// Exact queue capacity of the Rust SI source represented by V1 evidence.
pub const MACHINE_SI_QUEUE_CAPACITY: u32 = 64;
/// Exact maximum number of requests owned concurrently by the V1 Rust render boundary.
pub const MACHINE_RENDER_PENDING_CAPACITY: u32 = 8;

/// Rust-authenticated boot lifecycle and, after commit, immutable disc identity.
///
/// The six identifier bytes are packed as two big-endian semantic words. The second word's low
/// 16 bits must be zero, so `GZWE01` is `[0x475a_5745, 0x3031_0000]` independent of host endian.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct MachineBootEvidenceV1 {
    pub boot_epoch: EvidenceU64,
    pub logical_bytes: EvidenceU64,
    pub identifier_be_words: [u32; 2],
    pub status_raw: u32,
    pub fault_raw: u32,
    pub revision: u32,
    pub disc_number: u32,
    pub format_raw: u32,
}

impl MachineBootEvidenceV1 {
    pub fn status(self) -> Result<MachineBootStatus, UnknownDiscriminant> {
        MachineBootStatus::try_from(self.status_raw)
    }

    pub fn fault(self) -> Result<MachineBootFault, UnknownDiscriminant> {
        MachineBootFault::try_from(self.fault_raw)
    }

    pub fn format(self) -> Result<MachineDiscFormat, UnknownDiscriminant> {
        MachineDiscFormat::try_from(self.format_raw)
    }

    #[must_use]
    pub const fn identifier(self) -> [u8; 6] {
        let first = self.identifier_be_words[0].to_be_bytes();
        let second = self.identifier_be_words[1].to_be_bytes();
        [first[0], first[1], first[2], first[3], second[0], second[1]]
    }

    #[must_use]
    pub fn has_canonical_shape(self, has_identity: bool) -> bool {
        let Ok(status) = self.status() else {
            return false;
        };
        let Ok(fault) = self.fault() else {
            return false;
        };
        let lifecycle_valid = match status {
            MachineBootStatus::Idle => {
                self.boot_epoch.get() == 0 && fault == MachineBootFault::None
            }
            MachineBootStatus::Planning | MachineBootStatus::Loading => {
                self.boot_epoch.get() != 0 && fault == MachineBootFault::None
            }
            MachineBootStatus::Committed => {
                self.boot_epoch.get() != 0 && fault == MachineBootFault::None && has_identity
            }
            MachineBootStatus::Failed => match fault {
                MachineBootFault::None => false,
                MachineBootFault::EpochExhausted => self.boot_epoch.get() == 0,
                _ => self.boot_epoch.get() != 0,
            },
            MachineBootStatus::Cancelled => {
                self.boot_epoch.get() == 0 && fault == MachineBootFault::None
            }
        };
        let identity_valid = if has_identity {
            status == MachineBootStatus::Committed
                && self.boot_epoch.get() != 0
                && self.logical_bytes.get() != 0
                && self.identifier_be_words[0] != 0
                && self.identifier_be_words[1] & 0x0000_ffff == 0
                && u8::try_from(self.revision).is_ok()
                && u8::try_from(self.disc_number).is_ok()
                && self.format().is_ok()
        } else {
            self.logical_bytes.get() == 0
                && self.identifier_be_words == [0; 2]
                && self.revision == 0
                && self.disc_number == 0
                && self.format_raw == 0
        };
        lifecycle_valid && identity_valid
    }
}

/// Scheduler totals admitted only after the resident coordinator accepts a dispatch report.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct MachineSchedulerEvidenceV1 {
    pub canonical_cycle: EvidenceU64,
    pub executed_cycles: EvidenceU64,
    pub executed_instructions: EvidenceU64,
    pub address_space_generation: EvidenceU64,
    pub retired_blocks: EvidenceU64,
    pub completed_outer_slices: EvidenceU64,
    pub pc: u32,
    /// Exact raw [`RunReason`] for a sticky machine fault; zero when no fault flag is present.
    pub machine_fault_reason_raw: u32,
    pub machine_fault_detail: u32,
}

/// Rust-owned device totals. Every counter is cumulative for one machine epoch.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct MachineDeviceEvidenceV1 {
    pub raw_disk_reads: EvidenceU64,
    pub vi_fields: EvidenceU64,
    pub dsp_lle_steps: EvidenceU64,
    pub disk_device_errors: EvidenceU64,
    pub disk_request_errors: EvidenceU64,
    pub controller_queue_overflows: EvidenceU64,
    pub unknown_si_output_commands: EvidenceU64,
    pub unsupported_dtk_records: EvidenceU64,
    pub storage_faults_raised: EvidenceU64,
    pub storage_faults_returned: EvidenceU64,
    pub storage_faults_resolved: EvidenceU64,
    pub storage_fault_recurrences: EvidenceU64,
    pub storage_fault_nested: EvidenceU64,
    pub storage_fault_unrecoverable: EvidenceU64,
    pub di_last_error: u32,
    /// Zero or one; kept integer-only so the C ABI has no compiler-specific `bool` layout.
    pub storage_fault_pending: u32,
}

/// Rust-owned resident-DI lifecycle and physical host-boundary accounting.
///
/// This record intentionally excludes command words, DMA or guest addresses, disc offsets,
/// physical descriptors, payload bytes, and inquiry response bytes. Rejected host receipts are
/// attempts that did not consume the live physical request and therefore do not participate in
/// the exact issued-request retirement balance.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct MachineDiEvidenceV1 {
    pub command_starts: EvidenceU64,
    pub command_completions: EvidenceU64,
    pub command_cancellations: EvidenceU64,
    pub command_start_rejections: EvidenceU64,
    pub inquiry_starts: EvidenceU64,
    pub inquiry_completions: EvidenceU64,
    pub inquiry_cancellations: EvidenceU64,
    pub inquiry_start_rejections: EvidenceU64,
    pub read_starts: EvidenceU64,
    pub read_sector_starts: EvidenceU64,
    pub read_disc_id_starts: EvidenceU64,
    pub read_completions: EvidenceU64,
    pub read_cancellations: EvidenceU64,
    pub read_start_rejections: EvidenceU64,
    pub read_device_failures: EvidenceU64,
    pub physical_host_requests_issued: EvidenceU64,
    pub physical_host_requests_cancelled: EvidenceU64,
    pub host_receipts_succeeded: EvidenceU64,
    pub host_receipts_failed: EvidenceU64,
    pub host_receipts_rejected: EvidenceU64,
    pub logical_windows_ready: EvidenceU64,
    pub logical_windows_failed: EvidenceU64,
    pub current_state_raw: u32,
    pub current_kind_raw: u32,
    /// Zero or one; a published physical request not yet consumed or cancelled.
    pub physical_host_request_pending: u32,
    pub reserved: u32,
}

impl MachineDiEvidenceV1 {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            command_starts: EvidenceU64::new(0),
            command_completions: EvidenceU64::new(0),
            command_cancellations: EvidenceU64::new(0),
            command_start_rejections: EvidenceU64::new(0),
            inquiry_starts: EvidenceU64::new(0),
            inquiry_completions: EvidenceU64::new(0),
            inquiry_cancellations: EvidenceU64::new(0),
            inquiry_start_rejections: EvidenceU64::new(0),
            read_starts: EvidenceU64::new(0),
            read_sector_starts: EvidenceU64::new(0),
            read_disc_id_starts: EvidenceU64::new(0),
            read_completions: EvidenceU64::new(0),
            read_cancellations: EvidenceU64::new(0),
            read_start_rejections: EvidenceU64::new(0),
            read_device_failures: EvidenceU64::new(0),
            physical_host_requests_issued: EvidenceU64::new(0),
            physical_host_requests_cancelled: EvidenceU64::new(0),
            host_receipts_succeeded: EvidenceU64::new(0),
            host_receipts_failed: EvidenceU64::new(0),
            host_receipts_rejected: EvidenceU64::new(0),
            logical_windows_ready: EvidenceU64::new(0),
            logical_windows_failed: EvidenceU64::new(0),
            current_state_raw: MachineDiLifecycleState::Idle as u32,
            current_kind_raw: MachineDiCommandKind::None as u32,
            physical_host_request_pending: 0,
            reserved: 0,
        }
    }

    pub fn current_state(self) -> Result<MachineDiLifecycleState, UnknownDiscriminant> {
        MachineDiLifecycleState::try_from(self.current_state_raw)
    }

    pub fn current_kind(self) -> Result<MachineDiCommandKind, UnknownDiscriminant> {
        MachineDiCommandKind::try_from(self.current_kind_raw)
    }

    #[must_use]
    pub fn has_canonical_shape(self) -> bool {
        let Ok(state) = self.current_state() else {
            return false;
        };
        let Ok(kind) = self.current_kind() else {
            return false;
        };
        let Some(read_kinds) = self
            .read_sector_starts
            .get()
            .checked_add(self.read_disc_id_starts.get())
        else {
            return false;
        };
        let Some(classified_starts) = self
            .inquiry_starts
            .get()
            .checked_add(self.read_starts.get())
        else {
            return false;
        };
        let Some(classified_completions) = self
            .inquiry_completions
            .get()
            .checked_add(self.read_completions.get())
        else {
            return false;
        };
        let Some(classified_cancellations) = self
            .inquiry_cancellations
            .get()
            .checked_add(self.read_cancellations.get())
        else {
            return false;
        };
        let Some(classified_rejections) = self
            .inquiry_start_rejections
            .get()
            .checked_add(self.read_start_rejections.get())
        else {
            return false;
        };
        let Some(retired_host_requests) = self
            .host_receipts_succeeded
            .get()
            .checked_add(self.host_receipts_failed.get())
            .and_then(|count| count.checked_add(self.physical_host_requests_cancelled.get()))
            .and_then(|count| count.checked_add(u64::from(self.physical_host_request_pending)))
        else {
            return false;
        };
        let is_read = matches!(
            kind,
            MachineDiCommandKind::ReadSector | MachineDiCommandKind::ReadDiscId
        );
        let live_accepted = u64::from(matches!(
            state,
            MachineDiLifecycleState::AwaitingDeadline
                | MachineDiLifecycleState::AwaitingHost
                | MachineDiLifecycleState::ReadReady
        ));
        let live_inquiry = u64::from(live_accepted != 0 && kind == MachineDiCommandKind::Inquiry);
        let live_read = u64::from(live_accepted != 0 && is_read);
        let Some(accounted_commands) = self
            .command_completions
            .get()
            .checked_add(self.command_cancellations.get())
            .and_then(|count| count.checked_add(live_accepted))
        else {
            return false;
        };
        let Some(accounted_inquiries) = self
            .inquiry_completions
            .get()
            .checked_add(self.inquiry_cancellations.get())
            .and_then(|count| count.checked_add(live_inquiry))
        else {
            return false;
        };
        let Some(accounted_reads) = self
            .read_completions
            .get()
            .checked_add(self.read_cancellations.get())
            .and_then(|count| count.checked_add(live_read))
        else {
            return false;
        };
        let current_valid = match state {
            MachineDiLifecycleState::Idle => {
                kind == MachineDiCommandKind::None && self.physical_host_request_pending == 0
            }
            MachineDiLifecycleState::StartPending => {
                kind != MachineDiCommandKind::None && self.physical_host_request_pending == 0
            }
            MachineDiLifecycleState::AwaitingDeadline => {
                kind != MachineDiCommandKind::None
                    && !is_read
                    && self.physical_host_request_pending == 0
            }
            MachineDiLifecycleState::AwaitingHost => is_read,
            MachineDiLifecycleState::ReadReady => {
                is_read && self.physical_host_request_pending == 0
            }
        };
        self.reserved == 0
            && self.physical_host_request_pending <= 1
            && read_kinds == self.read_starts.get()
            && classified_starts <= self.command_starts.get()
            && accounted_commands == self.command_starts.get()
            && accounted_inquiries == self.inquiry_starts.get()
            && accounted_reads == self.read_starts.get()
            && classified_completions <= self.command_completions.get()
            && classified_cancellations <= self.command_cancellations.get()
            && self.inquiry_start_rejections <= self.command_start_rejections
            && self.read_start_rejections <= self.command_start_rejections
            && classified_rejections <= self.command_start_rejections.get()
            && self.read_device_failures <= self.read_completions
            && self.logical_windows_failed <= self.read_starts
            && retired_host_requests == self.physical_host_requests_issued.get()
            && (self.physical_host_request_pending == 0
                || state == MachineDiLifecycleState::AwaitingHost)
            && current_valid
    }
}

/// Rust GX/VI totals and current bounded-buffer gauges.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct MachineGraphicsEvidenceV1 {
    pub gx_bytes: EvidenceU64,
    pub gx_drains: EvidenceU64,
    pub gx_commands: EvidenceU64,
    pub gx_primitives: EvidenceU64,
    pub xfb_copies: EvidenceU64,
    pub presented_frames: EvidenceU64,
    pub emergency_drains: EvidenceU64,
    pub decoder_errors: EvidenceU64,
    pub fallbacks: EvidenceU64,
    pub unsupported_records: EvidenceU64,
    pub exact_rejections: EvidenceU64,
    pub texture_errors: EvidenceU64,
    pub pending_bytes: EvidenceU64,
    pub decoder_carry_bytes: EvidenceU64,
}

/// Machine-side renderer boundary accounting; this does not claim WebGPU-internal work.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct MachineRenderEvidenceV1 {
    pub render_requests_issued: EvidenceU64,
    pub render_completions_authenticated: EvidenceU64,
    pub render_host_failures: EvidenceU64,
    pub render_renderer_failures: EvidenceU64,
    pub texture_copy_barriers_entered: EvidenceU64,
    pub texture_copy_barriers_exited: EvidenceU64,
    pub render_pending: u32,
    pub render_high_water: u32,
}

/// Last complete Rust-authenticated XFB selection and VI-render receipt chronology.
///
/// Deliberately absent are the XFB address, guest pointers, and pixel hashes. The record proves
/// correlation through Rust's retained generation, row, geometry, request sequence, and receipt.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct MachineXfbViEvidenceV1 {
    pub xfb_completion_cycle: EvidenceU64,
    pub vi_selection_cycle: EvidenceU64,
    pub render_completion_cycle: EvidenceU64,
    pub render_sequence: EvidenceU64,
    pub presentation_serial: EvidenceU64,
    pub xfb_generation: u32,
    pub selected_row: u32,
    pub mode_raw: u32,
    pub parity_raw: u32,
    pub pair_epoch: u32,
    pub xfb_width: u32,
    pub xfb_height: u32,
    pub xfb_stride: u32,
    pub output_width: u32,
    pub output_height: u32,
    pub field_stride_bytes: u32,
    pub field_height: u32,
    pub row_repeat: u32,
    pub presentation_status_raw: u32,
    pub presentation_width: u32,
    pub presentation_height: u32,
    pub flags: u32,
}

impl MachineXfbViEvidenceV1 {
    pub fn mode(self) -> Result<ViPresentationMode, UnknownDiscriminant> {
        ViPresentationMode::try_from(self.mode_raw)
    }

    pub fn parity(self) -> Result<ViFieldParity, UnknownDiscriminant> {
        ViFieldParity::try_from(self.parity_raw)
    }

    pub fn presentation_status(self) -> Result<RenderPresentationStatus, UnknownDiscriminant> {
        RenderPresentationStatus::try_from(self.presentation_status_raw)
    }

    #[must_use]
    pub const fn pair_completing(self) -> bool {
        self.flags & MACHINE_XFB_VI_PAIR_COMPLETING != 0
    }

    #[must_use]
    pub fn has_canonical_shape(self) -> bool {
        let Some(expected_height) = self.field_height.checked_mul(self.row_repeat) else {
            return false;
        };
        let Some(source_row_step) = self.field_stride_bytes.checked_div(self.xfb_stride) else {
            return false;
        };
        let Some(last_source_row) = self
            .field_height
            .checked_sub(1)
            .and_then(|rows| rows.checked_mul(source_row_step))
            .and_then(|rows| self.selected_row.checked_add(rows))
        else {
            return false;
        };
        let Ok(mode) = self.mode() else {
            return false;
        };
        let Ok(status) = self.presentation_status() else {
            return false;
        };
        self.render_sequence.get() != 0
            && self.xfb_generation != 0
            && self.pair_epoch != 0
            && self.xfb_width != 0
            && self.xfb_height != 0
            && self.xfb_stride != 0
            && self.output_width == self.xfb_width
            && self.output_height != 0
            && self.field_stride_bytes != 0
            && self.field_stride_bytes.is_multiple_of(self.xfb_stride)
            && self.field_height != 0
            && matches!(self.row_repeat, 1 | 2)
            && expected_height == self.output_height
            && last_source_row < self.xfb_height
            && self.parity().is_ok()
            && self.flags & !MACHINE_XFB_VI_PAIR_COMPLETING == 0
            && self.xfb_completion_cycle <= self.vi_selection_cycle
            && self.vi_selection_cycle <= self.render_completion_cycle
            && match status {
                RenderPresentationStatus::Rejected => {
                    self.presentation_width == 0
                        && self.presentation_height == 0
                        && self.presentation_serial.get() == 0
                }
                RenderPresentationStatus::Staged => {
                    mode == ViPresentationMode::Interlaced
                        && !self.pair_completing()
                        && self.presentation_width == self.output_width
                        && self.presentation_height == self.output_height
                        && self.presentation_serial.get() == 0
                }
                RenderPresentationStatus::Presented => {
                    self.pair_completing()
                        && self.presentation_width == self.output_width
                        && self.presentation_height == self.output_height
                        && self.presentation_serial.get() != 0
                }
            }
    }
}

/// Last controller sample made guest-visible by Rust SI service.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct MachineSiEvidenceV1 {
    pub poll_index: EvidenceU64,
    pub scheduled_cycle: EvidenceU64,
    pub observed_cycle: EvidenceU64,
    pub last_received_sequence: EvidenceU64,
    pub applied_sequence: EvidenceU64,
    /// Successful periodic publications made guest-visible, not attempted SI service phases.
    pub periodic_polls: EvidenceU64,
    /// Successful direct-transfer publications made guest-visible, not transfer attempts.
    pub direct_polls: EvidenceU64,
    /// Periodic SI service phases that could not publish because guest input remained unread.
    pub backpressured_polls: EvidenceU64,
    /// Exact guest-visible packet packed as two big-endian semantic words.
    pub packet_be_words: [u32; 2],
    pub queue_depth: u32,
    pub source_raw: u32,
}

impl MachineSiEvidenceV1 {
    pub fn source(self) -> Result<MachineSiPollSource, UnknownDiscriminant> {
        MachineSiPollSource::try_from(self.source_raw)
    }

    #[must_use]
    pub const fn packet(self) -> [u8; 8] {
        let first = self.packet_be_words[0].to_be_bytes();
        let second = self.packet_be_words[1].to_be_bytes();
        [
            first[0], first[1], first[2], first[3], second[0], second[1], second[2], second[3],
        ]
    }

    #[must_use]
    pub fn has_canonical_shape(self, has_publication: bool) -> bool {
        let poll_total = self
            .periodic_polls
            .get()
            .checked_add(self.direct_polls.get());
        self.queue_depth <= MACHINE_SI_QUEUE_CAPACITY
            && self.applied_sequence <= self.last_received_sequence
            && poll_total == Some(self.poll_index.get())
            && if has_publication {
                self.poll_index.get() != 0
                    && self.scheduled_cycle <= self.observed_cycle
                    && self.source().is_ok()
            } else {
                self.poll_index.get() == 0
                    && self.scheduled_cycle.get() == 0
                    && self.observed_cycle.get() == 0
                    && self.applied_sequence.get() == 0
                    && self.packet_be_words == [0; 2]
                    && self.source_raw == 0
            }
    }
}

/// Fixed 816-byte Rust-authored generic evidence snapshot for one resident machine epoch.
///
/// This record is intentionally narrower than the complete browser fidelity report. It contains
/// only scheduler/device/GX state and request/receipt chronology accepted by Rust. Renderer pixel
/// bytes and title-specific guest projections belong to separately authenticated evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct MachineEvidenceV1 {
    pub header: RecordHeader,
    pub tag: u32,
    pub flags: u32,
    pub machine_epoch: EvidenceU64,
    pub snapshot_serial: EvidenceU64,
    pub boot: MachineBootEvidenceV1,
    pub scheduler: MachineSchedulerEvidenceV1,
    pub device: MachineDeviceEvidenceV1,
    pub graphics: MachineGraphicsEvidenceV1,
    pub renderer: MachineRenderEvidenceV1,
    pub xfb_vi: MachineXfbViEvidenceV1,
    pub si: MachineSiEvidenceV1,
    /// Cycles committed by exact Rust-authenticated semantic idle-to-event jumps.
    pub semantic_idle_cycles: EvidenceU64,
    /// Number of committed semantic idle-to-event jumps.
    pub semantic_idle_jumps: u32,
    pub di: MachineDiEvidenceV1,
}

impl MachineEvidenceV1 {
    pub const WORD_LEN: usize = 204;
    pub const BYTE_LEN: usize = Self::WORD_LEN * size_of::<u32>();

    #[must_use]
    pub const fn new(machine_epoch: u64, snapshot_serial: u64) -> Self {
        Self {
            header: RecordHeader::for_record::<Self>(),
            tag: MACHINE_EVIDENCE_V1_TAG,
            flags: 0,
            machine_epoch: EvidenceU64::new(machine_epoch),
            snapshot_serial: EvidenceU64::new(snapshot_serial),
            boot: MachineBootEvidenceV1 {
                boot_epoch: EvidenceU64::new(0),
                logical_bytes: EvidenceU64::new(0),
                identifier_be_words: [0; 2],
                status_raw: MachineBootStatus::Idle as u32,
                fault_raw: MachineBootFault::None as u32,
                revision: 0,
                disc_number: 0,
                format_raw: 0,
            },
            scheduler: MachineSchedulerEvidenceV1 {
                canonical_cycle: EvidenceU64::new(0),
                executed_cycles: EvidenceU64::new(0),
                executed_instructions: EvidenceU64::new(0),
                address_space_generation: EvidenceU64::new(0),
                retired_blocks: EvidenceU64::new(0),
                completed_outer_slices: EvidenceU64::new(0),
                pc: 0,
                machine_fault_reason_raw: 0,
                machine_fault_detail: 0,
            },
            device: MachineDeviceEvidenceV1 {
                raw_disk_reads: EvidenceU64::new(0),
                vi_fields: EvidenceU64::new(0),
                dsp_lle_steps: EvidenceU64::new(0),
                disk_device_errors: EvidenceU64::new(0),
                disk_request_errors: EvidenceU64::new(0),
                controller_queue_overflows: EvidenceU64::new(0),
                unknown_si_output_commands: EvidenceU64::new(0),
                unsupported_dtk_records: EvidenceU64::new(0),
                storage_faults_raised: EvidenceU64::new(0),
                storage_faults_returned: EvidenceU64::new(0),
                storage_faults_resolved: EvidenceU64::new(0),
                storage_fault_recurrences: EvidenceU64::new(0),
                storage_fault_nested: EvidenceU64::new(0),
                storage_fault_unrecoverable: EvidenceU64::new(0),
                di_last_error: 0,
                storage_fault_pending: 0,
            },
            graphics: MachineGraphicsEvidenceV1 {
                gx_bytes: EvidenceU64::new(0),
                gx_drains: EvidenceU64::new(0),
                gx_commands: EvidenceU64::new(0),
                gx_primitives: EvidenceU64::new(0),
                xfb_copies: EvidenceU64::new(0),
                presented_frames: EvidenceU64::new(0),
                emergency_drains: EvidenceU64::new(0),
                decoder_errors: EvidenceU64::new(0),
                fallbacks: EvidenceU64::new(0),
                unsupported_records: EvidenceU64::new(0),
                exact_rejections: EvidenceU64::new(0),
                texture_errors: EvidenceU64::new(0),
                pending_bytes: EvidenceU64::new(0),
                decoder_carry_bytes: EvidenceU64::new(0),
            },
            renderer: MachineRenderEvidenceV1 {
                render_requests_issued: EvidenceU64::new(0),
                render_completions_authenticated: EvidenceU64::new(0),
                render_host_failures: EvidenceU64::new(0),
                render_renderer_failures: EvidenceU64::new(0),
                texture_copy_barriers_entered: EvidenceU64::new(0),
                texture_copy_barriers_exited: EvidenceU64::new(0),
                render_pending: 0,
                render_high_water: 0,
            },
            xfb_vi: MachineXfbViEvidenceV1 {
                xfb_completion_cycle: EvidenceU64::new(0),
                vi_selection_cycle: EvidenceU64::new(0),
                render_completion_cycle: EvidenceU64::new(0),
                render_sequence: EvidenceU64::new(0),
                presentation_serial: EvidenceU64::new(0),
                xfb_generation: 0,
                selected_row: 0,
                mode_raw: 0,
                parity_raw: 0,
                pair_epoch: 0,
                xfb_width: 0,
                xfb_height: 0,
                xfb_stride: 0,
                output_width: 0,
                output_height: 0,
                field_stride_bytes: 0,
                field_height: 0,
                row_repeat: 0,
                presentation_status_raw: 0,
                presentation_width: 0,
                presentation_height: 0,
                flags: 0,
            },
            si: MachineSiEvidenceV1 {
                poll_index: EvidenceU64::new(0),
                scheduled_cycle: EvidenceU64::new(0),
                observed_cycle: EvidenceU64::new(0),
                last_received_sequence: EvidenceU64::new(0),
                applied_sequence: EvidenceU64::new(0),
                periodic_polls: EvidenceU64::new(0),
                direct_polls: EvidenceU64::new(0),
                backpressured_polls: EvidenceU64::new(0),
                packet_be_words: [0; 2],
                queue_depth: 0,
                source_raw: 0,
            },
            semantic_idle_cycles: EvidenceU64::new(0),
            semantic_idle_jumps: 0,
            di: MachineDiEvidenceV1::new(),
        }
    }

    #[must_use]
    pub fn has_canonical_shape(self) -> bool {
        let render_requests = self.renderer.render_requests_issued.get();
        let render_completions = self.renderer.render_completions_authenticated.get();
        let render_failures = self
            .renderer
            .render_host_failures
            .get()
            .checked_add(self.renderer.render_renderer_failures.get());
        let renderer_balanced = render_completions
            .checked_add(u64::from(self.renderer.render_pending))
            == Some(render_requests)
            && render_failures.is_some_and(|failures| failures <= render_completions)
            && self.renderer.render_pending <= self.renderer.render_high_water
            && self.renderer.render_high_water <= MACHINE_RENDER_PENDING_CAPACITY
            && self.renderer.texture_copy_barriers_exited
                <= self.renderer.texture_copy_barriers_entered;
        let storage_ordered = self.device.storage_faults_resolved
            <= self.device.storage_faults_returned
            && self.device.storage_faults_returned <= self.device.storage_faults_raised;
        let has_machine_fault = self.flags & MACHINE_EVIDENCE_TERMINAL_ERROR != 0;
        let machine_fault_valid = if has_machine_fault {
            matches!(
                RunReason::try_from(self.scheduler.machine_fault_reason_raw),
                Ok(RunReason::Fault | RunReason::InvalidState)
            ) && self.scheduler.machine_fault_detail != 0
        } else {
            self.scheduler.machine_fault_reason_raw == 0 && self.scheduler.machine_fault_detail == 0
        };
        let has_boot_identity = self.flags & MACHINE_EVIDENCE_HAS_BOOT_IDENTITY != 0;
        let has_xfb_vi = self.flags & MACHINE_EVIDENCE_HAS_XFB_VI != 0;
        let has_si = self.flags & MACHINE_EVIDENCE_HAS_SI_PUBLICATION != 0;
        self.header == RecordHeader::for_record::<Self>()
            && self.tag == MACHINE_EVIDENCE_V1_TAG
            && self.flags & !MACHINE_EVIDENCE_KNOWN_FLAGS == 0
            && self.machine_epoch.get() != 0
            && self.snapshot_serial.get() != 0
            && self.boot.has_canonical_shape(has_boot_identity)
            && self.scheduler.executed_cycles <= self.scheduler.canonical_cycle
            && self.scheduler.pc & 3 == 0
            && machine_fault_valid
            && self.device.storage_fault_pending <= 1
            && storage_ordered
            && renderer_balanced
            && (!has_xfb_vi && self.xfb_vi == MachineXfbViEvidenceV1::default()
                || has_xfb_vi
                    && self.xfb_vi.has_canonical_shape()
                    && self.xfb_vi.render_completion_cycle <= self.scheduler.canonical_cycle
                    && self.xfb_vi.render_sequence.get() <= render_completions
                    && self.graphics.xfb_copies.get() != 0
                    && (self.xfb_vi.presentation_status()
                        != Ok(RenderPresentationStatus::Presented)
                        || self.graphics.presented_frames.get() != 0))
            && self.si.has_canonical_shape(has_si)
            && (!has_si || self.si.observed_cycle <= self.scheduler.canonical_cycle)
            && self.semantic_idle_cycles <= self.scheduler.executed_cycles
            && (self.semantic_idle_jumps == 0) == (self.semantic_idle_cycles.get() == 0)
            && self.di.has_canonical_shape()
    }

    #[must_use]
    fn words(self) -> [u32; Self::WORD_LEN] {
        [
            self.header.abi_version,
            self.header.byte_len,
            self.tag,
            self.flags,
            self.machine_epoch.lo,
            self.machine_epoch.hi,
            self.snapshot_serial.lo,
            self.snapshot_serial.hi,
            self.boot.boot_epoch.lo,
            self.boot.boot_epoch.hi,
            self.boot.logical_bytes.lo,
            self.boot.logical_bytes.hi,
            self.boot.identifier_be_words[0],
            self.boot.identifier_be_words[1],
            self.boot.status_raw,
            self.boot.fault_raw,
            self.boot.revision,
            self.boot.disc_number,
            self.boot.format_raw,
            self.scheduler.canonical_cycle.lo,
            self.scheduler.canonical_cycle.hi,
            self.scheduler.executed_cycles.lo,
            self.scheduler.executed_cycles.hi,
            self.scheduler.executed_instructions.lo,
            self.scheduler.executed_instructions.hi,
            self.scheduler.address_space_generation.lo,
            self.scheduler.address_space_generation.hi,
            self.scheduler.retired_blocks.lo,
            self.scheduler.retired_blocks.hi,
            self.scheduler.completed_outer_slices.lo,
            self.scheduler.completed_outer_slices.hi,
            self.scheduler.pc,
            self.scheduler.machine_fault_reason_raw,
            self.scheduler.machine_fault_detail,
            self.device.raw_disk_reads.lo,
            self.device.raw_disk_reads.hi,
            self.device.vi_fields.lo,
            self.device.vi_fields.hi,
            self.device.dsp_lle_steps.lo,
            self.device.dsp_lle_steps.hi,
            self.device.disk_device_errors.lo,
            self.device.disk_device_errors.hi,
            self.device.disk_request_errors.lo,
            self.device.disk_request_errors.hi,
            self.device.controller_queue_overflows.lo,
            self.device.controller_queue_overflows.hi,
            self.device.unknown_si_output_commands.lo,
            self.device.unknown_si_output_commands.hi,
            self.device.unsupported_dtk_records.lo,
            self.device.unsupported_dtk_records.hi,
            self.device.storage_faults_raised.lo,
            self.device.storage_faults_raised.hi,
            self.device.storage_faults_returned.lo,
            self.device.storage_faults_returned.hi,
            self.device.storage_faults_resolved.lo,
            self.device.storage_faults_resolved.hi,
            self.device.storage_fault_recurrences.lo,
            self.device.storage_fault_recurrences.hi,
            self.device.storage_fault_nested.lo,
            self.device.storage_fault_nested.hi,
            self.device.storage_fault_unrecoverable.lo,
            self.device.storage_fault_unrecoverable.hi,
            self.device.di_last_error,
            self.device.storage_fault_pending,
            self.graphics.gx_bytes.lo,
            self.graphics.gx_bytes.hi,
            self.graphics.gx_drains.lo,
            self.graphics.gx_drains.hi,
            self.graphics.gx_commands.lo,
            self.graphics.gx_commands.hi,
            self.graphics.gx_primitives.lo,
            self.graphics.gx_primitives.hi,
            self.graphics.xfb_copies.lo,
            self.graphics.xfb_copies.hi,
            self.graphics.presented_frames.lo,
            self.graphics.presented_frames.hi,
            self.graphics.emergency_drains.lo,
            self.graphics.emergency_drains.hi,
            self.graphics.decoder_errors.lo,
            self.graphics.decoder_errors.hi,
            self.graphics.fallbacks.lo,
            self.graphics.fallbacks.hi,
            self.graphics.unsupported_records.lo,
            self.graphics.unsupported_records.hi,
            self.graphics.exact_rejections.lo,
            self.graphics.exact_rejections.hi,
            self.graphics.texture_errors.lo,
            self.graphics.texture_errors.hi,
            self.graphics.pending_bytes.lo,
            self.graphics.pending_bytes.hi,
            self.graphics.decoder_carry_bytes.lo,
            self.graphics.decoder_carry_bytes.hi,
            self.renderer.render_requests_issued.lo,
            self.renderer.render_requests_issued.hi,
            self.renderer.render_completions_authenticated.lo,
            self.renderer.render_completions_authenticated.hi,
            self.renderer.render_host_failures.lo,
            self.renderer.render_host_failures.hi,
            self.renderer.render_renderer_failures.lo,
            self.renderer.render_renderer_failures.hi,
            self.renderer.texture_copy_barriers_entered.lo,
            self.renderer.texture_copy_barriers_entered.hi,
            self.renderer.texture_copy_barriers_exited.lo,
            self.renderer.texture_copy_barriers_exited.hi,
            self.renderer.render_pending,
            self.renderer.render_high_water,
            self.xfb_vi.xfb_completion_cycle.lo,
            self.xfb_vi.xfb_completion_cycle.hi,
            self.xfb_vi.vi_selection_cycle.lo,
            self.xfb_vi.vi_selection_cycle.hi,
            self.xfb_vi.render_completion_cycle.lo,
            self.xfb_vi.render_completion_cycle.hi,
            self.xfb_vi.render_sequence.lo,
            self.xfb_vi.render_sequence.hi,
            self.xfb_vi.presentation_serial.lo,
            self.xfb_vi.presentation_serial.hi,
            self.xfb_vi.xfb_generation,
            self.xfb_vi.selected_row,
            self.xfb_vi.mode_raw,
            self.xfb_vi.parity_raw,
            self.xfb_vi.pair_epoch,
            self.xfb_vi.xfb_width,
            self.xfb_vi.xfb_height,
            self.xfb_vi.xfb_stride,
            self.xfb_vi.output_width,
            self.xfb_vi.output_height,
            self.xfb_vi.field_stride_bytes,
            self.xfb_vi.field_height,
            self.xfb_vi.row_repeat,
            self.xfb_vi.presentation_status_raw,
            self.xfb_vi.presentation_width,
            self.xfb_vi.presentation_height,
            self.xfb_vi.flags,
            self.si.poll_index.lo,
            self.si.poll_index.hi,
            self.si.scheduled_cycle.lo,
            self.si.scheduled_cycle.hi,
            self.si.observed_cycle.lo,
            self.si.observed_cycle.hi,
            self.si.last_received_sequence.lo,
            self.si.last_received_sequence.hi,
            self.si.applied_sequence.lo,
            self.si.applied_sequence.hi,
            self.si.periodic_polls.lo,
            self.si.periodic_polls.hi,
            self.si.direct_polls.lo,
            self.si.direct_polls.hi,
            self.si.backpressured_polls.lo,
            self.si.backpressured_polls.hi,
            self.si.packet_be_words[0],
            self.si.packet_be_words[1],
            self.si.queue_depth,
            self.si.source_raw,
            self.semantic_idle_cycles.lo,
            self.semantic_idle_cycles.hi,
            self.semantic_idle_jumps,
            self.di.command_starts.lo,
            self.di.command_starts.hi,
            self.di.command_completions.lo,
            self.di.command_completions.hi,
            self.di.command_cancellations.lo,
            self.di.command_cancellations.hi,
            self.di.command_start_rejections.lo,
            self.di.command_start_rejections.hi,
            self.di.inquiry_starts.lo,
            self.di.inquiry_starts.hi,
            self.di.inquiry_completions.lo,
            self.di.inquiry_completions.hi,
            self.di.inquiry_cancellations.lo,
            self.di.inquiry_cancellations.hi,
            self.di.inquiry_start_rejections.lo,
            self.di.inquiry_start_rejections.hi,
            self.di.read_starts.lo,
            self.di.read_starts.hi,
            self.di.read_sector_starts.lo,
            self.di.read_sector_starts.hi,
            self.di.read_disc_id_starts.lo,
            self.di.read_disc_id_starts.hi,
            self.di.read_completions.lo,
            self.di.read_completions.hi,
            self.di.read_cancellations.lo,
            self.di.read_cancellations.hi,
            self.di.read_start_rejections.lo,
            self.di.read_start_rejections.hi,
            self.di.read_device_failures.lo,
            self.di.read_device_failures.hi,
            self.di.physical_host_requests_issued.lo,
            self.di.physical_host_requests_issued.hi,
            self.di.physical_host_requests_cancelled.lo,
            self.di.physical_host_requests_cancelled.hi,
            self.di.host_receipts_succeeded.lo,
            self.di.host_receipts_succeeded.hi,
            self.di.host_receipts_failed.lo,
            self.di.host_receipts_failed.hi,
            self.di.host_receipts_rejected.lo,
            self.di.host_receipts_rejected.hi,
            self.di.logical_windows_ready.lo,
            self.di.logical_windows_ready.hi,
            self.di.logical_windows_failed.lo,
            self.di.logical_windows_failed.hi,
            self.di.current_state_raw,
            self.di.current_kind_raw,
            self.di.physical_host_request_pending,
            self.di.reserved,
        ]
    }

    #[must_use]
    fn from_words(word: &[u32; Self::WORD_LEN]) -> Self {
        let pair = |index: usize| EvidenceU64 {
            lo: word[index],
            hi: word[index + 1],
        };
        Self {
            header: RecordHeader {
                abi_version: word[0],
                byte_len: word[1],
            },
            tag: word[2],
            flags: word[3],
            machine_epoch: pair(4),
            snapshot_serial: pair(6),
            boot: MachineBootEvidenceV1 {
                boot_epoch: pair(8),
                logical_bytes: pair(10),
                identifier_be_words: [word[12], word[13]],
                status_raw: word[14],
                fault_raw: word[15],
                revision: word[16],
                disc_number: word[17],
                format_raw: word[18],
            },
            scheduler: MachineSchedulerEvidenceV1 {
                canonical_cycle: pair(19),
                executed_cycles: pair(21),
                executed_instructions: pair(23),
                address_space_generation: pair(25),
                retired_blocks: pair(27),
                completed_outer_slices: pair(29),
                pc: word[31],
                machine_fault_reason_raw: word[32],
                machine_fault_detail: word[33],
            },
            device: MachineDeviceEvidenceV1 {
                raw_disk_reads: pair(34),
                vi_fields: pair(36),
                dsp_lle_steps: pair(38),
                disk_device_errors: pair(40),
                disk_request_errors: pair(42),
                controller_queue_overflows: pair(44),
                unknown_si_output_commands: pair(46),
                unsupported_dtk_records: pair(48),
                storage_faults_raised: pair(50),
                storage_faults_returned: pair(52),
                storage_faults_resolved: pair(54),
                storage_fault_recurrences: pair(56),
                storage_fault_nested: pair(58),
                storage_fault_unrecoverable: pair(60),
                di_last_error: word[62],
                storage_fault_pending: word[63],
            },
            graphics: MachineGraphicsEvidenceV1 {
                gx_bytes: pair(64),
                gx_drains: pair(66),
                gx_commands: pair(68),
                gx_primitives: pair(70),
                xfb_copies: pair(72),
                presented_frames: pair(74),
                emergency_drains: pair(76),
                decoder_errors: pair(78),
                fallbacks: pair(80),
                unsupported_records: pair(82),
                exact_rejections: pair(84),
                texture_errors: pair(86),
                pending_bytes: pair(88),
                decoder_carry_bytes: pair(90),
            },
            renderer: MachineRenderEvidenceV1 {
                render_requests_issued: pair(92),
                render_completions_authenticated: pair(94),
                render_host_failures: pair(96),
                render_renderer_failures: pair(98),
                texture_copy_barriers_entered: pair(100),
                texture_copy_barriers_exited: pair(102),
                render_pending: word[104],
                render_high_water: word[105],
            },
            xfb_vi: MachineXfbViEvidenceV1 {
                xfb_completion_cycle: pair(106),
                vi_selection_cycle: pair(108),
                render_completion_cycle: pair(110),
                render_sequence: pair(112),
                presentation_serial: pair(114),
                xfb_generation: word[116],
                selected_row: word[117],
                mode_raw: word[118],
                parity_raw: word[119],
                pair_epoch: word[120],
                xfb_width: word[121],
                xfb_height: word[122],
                xfb_stride: word[123],
                output_width: word[124],
                output_height: word[125],
                field_stride_bytes: word[126],
                field_height: word[127],
                row_repeat: word[128],
                presentation_status_raw: word[129],
                presentation_width: word[130],
                presentation_height: word[131],
                flags: word[132],
            },
            si: MachineSiEvidenceV1 {
                poll_index: pair(133),
                scheduled_cycle: pair(135),
                observed_cycle: pair(137),
                last_received_sequence: pair(139),
                applied_sequence: pair(141),
                periodic_polls: pair(143),
                direct_polls: pair(145),
                backpressured_polls: pair(147),
                packet_be_words: [word[149], word[150]],
                queue_depth: word[151],
                source_raw: word[152],
            },
            semantic_idle_cycles: pair(153),
            semantic_idle_jumps: word[155],
            di: MachineDiEvidenceV1 {
                command_starts: pair(156),
                command_completions: pair(158),
                command_cancellations: pair(160),
                command_start_rejections: pair(162),
                inquiry_starts: pair(164),
                inquiry_completions: pair(166),
                inquiry_cancellations: pair(168),
                inquiry_start_rejections: pair(170),
                read_starts: pair(172),
                read_sector_starts: pair(174),
                read_disc_id_starts: pair(176),
                read_completions: pair(178),
                read_cancellations: pair(180),
                read_start_rejections: pair(182),
                read_device_failures: pair(184),
                physical_host_requests_issued: pair(186),
                physical_host_requests_cancelled: pair(188),
                host_receipts_succeeded: pair(190),
                host_receipts_failed: pair(192),
                host_receipts_rejected: pair(194),
                logical_windows_ready: pair(196),
                logical_windows_failed: pair(198),
                current_state_raw: word[200],
                current_kind_raw: word[201],
                physical_host_request_pending: word[202],
                reserved: word[203],
            },
        }
    }

    /// Decode one exact canonical little-endian evidence record.
    #[must_use]
    pub fn decode_le(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != Self::BYTE_LEN {
            return None;
        }
        let mut words = [0_u32; Self::WORD_LEN];
        for (destination, source) in words.iter_mut().zip(bytes.chunks_exact(size_of::<u32>())) {
            *destination = u32::from_le_bytes([source[0], source[1], source[2], source[3]]);
        }
        let record = Self::from_words(&words);
        record.has_canonical_shape().then_some(record)
    }

    /// Encode only an exact canonical record into an exact-size destination.
    pub fn encode_le(self, bytes: &mut [u8]) -> bool {
        if bytes.len() != Self::BYTE_LEN || !self.has_canonical_shape() {
            return false;
        }
        for (destination, word) in bytes.chunks_exact_mut(size_of::<u32>()).zip(self.words()) {
            destination.copy_from_slice(&word.to_le_bytes());
        }
        true
    }
}

/// Maximum number of hashed instruction-page mappings retained by one 64-instruction block.
pub const DISPATCH_MAX_DEPENDENCIES: usize = 2;
/// Publication marker written last by the Rust cache owner.
pub const DISPATCH_ENTRY_READY: u32 = 0x4c5a_454e;
/// Publication marker written last by the Rust function-table owner.
pub const DISPATCH_SLOT_READY: u32 = 0x4c5a_534c;
/// Wire kind for a basic PPC block. Regions are linked internally by Rust and never installed as
/// host-described semantic records.
pub const DISPATCH_BASIC_BLOCK_KIND: u32 = 0;

/// One retained hashed instruction-page mapping in the resident-dispatch directory.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct DispatchDependency {
    pub effective_page: u32,
    pub physical_page: u32,
}

impl DispatchDependency {
    #[must_use]
    pub const fn is_page_aligned(self) -> bool {
        self.effective_page & 0x0fff == 0 && self.physical_page & 0x0fff == 0
    }
}

/// Hot Rust-authored cache record consumed by the persistent Wasm dispatcher.
///
/// This is intentionally not a host request. Rust writes every field while `state == 0`, writes
/// the matching slot identity, and publishes [`DISPATCH_ENTRY_READY`] last. The browser adapter
/// never chooses or interprets these fields.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct DispatchCacheRecord {
    pub state: u32,
    pub kind: u32,
    pub pc: u32,
    pub address_space_generation_lo: u32,
    pub address_space_generation_hi: u32,
    pub table_slot: u32,
    pub slot_nonce_lo: u32,
    pub slot_nonce_hi: u32,
    /// Lower 16 bits are maximum instructions; upper 16 bits are maximum cycles.
    pub maximum_executed: u32,
    pub dependency_count: u32,
    pub dependencies: [DispatchDependency; DISPATCH_MAX_DEPENDENCIES],
}

impl DispatchCacheRecord {
    #[allow(clippy::too_many_arguments)]
    #[must_use]
    pub fn unpublished_basic_block(
        pc: u32,
        address_space_generation: u64,
        table_slot: u32,
        slot_nonce: u64,
        maximum_cycles: u16,
        maximum_instructions: u16,
        dependencies: &[DispatchDependency],
    ) -> Option<Self> {
        if pc & 3 != 0
            || maximum_cycles == 0
            || maximum_instructions == 0
            || dependencies.len() > DISPATCH_MAX_DEPENDENCIES
            || dependencies
                .iter()
                .copied()
                .any(|dependency| !dependency.is_page_aligned())
        {
            return None;
        }
        let mut retained = [DispatchDependency::default(); DISPATCH_MAX_DEPENDENCIES];
        retained[..dependencies.len()].copy_from_slice(dependencies);
        Some(Self {
            state: 0,
            kind: DISPATCH_BASIC_BLOCK_KIND,
            pc,
            address_space_generation_lo: address_space_generation as u32,
            address_space_generation_hi: (address_space_generation >> 32) as u32,
            table_slot,
            slot_nonce_lo: slot_nonce as u32,
            slot_nonce_hi: (slot_nonce >> 32) as u32,
            maximum_executed: u32::from(maximum_instructions) | (u32::from(maximum_cycles) << 16),
            dependency_count: dependencies.len() as u32,
            dependencies: retained,
        })
    }

    #[must_use]
    pub const fn address_space_generation(self) -> u64 {
        self.address_space_generation_lo as u64 | ((self.address_space_generation_hi as u64) << 32)
    }

    #[must_use]
    pub const fn slot_nonce(self) -> u64 {
        self.slot_nonce_lo as u64 | ((self.slot_nonce_hi as u64) << 32)
    }

    #[must_use]
    pub const fn maximum_instructions(self) -> u16 {
        self.maximum_executed as u16
    }

    #[must_use]
    pub const fn maximum_cycles(self) -> u16 {
        (self.maximum_executed >> 16) as u16
    }

    #[must_use]
    pub const fn published(mut self) -> Self {
        self.state = DISPATCH_ENTRY_READY;
        self
    }
}

/// Exact identity of the compiled function occupying one dispatcher table slot.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct DispatchSlotIdentityRecord {
    pub state: u32,
    pub pc: u32,
    pub address_space_generation_lo: u32,
    pub address_space_generation_hi: u32,
    pub slot_nonce_lo: u32,
    pub slot_nonce_hi: u32,
    pub reserved: [u32; 2],
}

impl DispatchSlotIdentityRecord {
    #[must_use]
    pub const fn unpublished(pc: u32, address_space_generation: u64, slot_nonce: u64) -> Self {
        Self {
            state: 0,
            pc,
            address_space_generation_lo: address_space_generation as u32,
            address_space_generation_hi: (address_space_generation >> 32) as u32,
            slot_nonce_lo: slot_nonce as u32,
            slot_nonce_hi: (slot_nonce >> 32) as u32,
            reserved: [0; 2],
        }
    }

    #[must_use]
    pub const fn slot_nonce(self) -> u64 {
        self.slot_nonce_lo as u64 | ((self.slot_nonce_hi as u64) << 32)
    }

    #[must_use]
    pub const fn published(mut self) -> Self {
        self.state = DISPATCH_SLOT_READY;
        self
    }
}

/// Fixed browser linear-memory layout shared by Lazuli WebAssembly modules.
///
/// The architected storage windows and initial memory are common, but the legacy JavaScript/DSP
/// machine and the Rust-resident machine deliberately have different growth ceilings.  Keep the
/// names explicit at every linker/import boundary: accidentally giving the legacy machine the
/// resident ceiling would retain up to 80 MiB of additional browser memory, while accidentally
/// giving the resident machine the legacy ceiling prevents legal disc and GX payloads from being
/// represented atomically in Rust.
pub mod memory {
    pub const WASM_PAGE_BYTES: usize = 64 * 1024;
    pub const LEGACY_MEMORY_INITIAL_PAGES: usize = 720;
    pub const LEGACY_MEMORY_MAXIMUM_PAGES: usize = 768;
    pub const LEGACY_MEMORY_BYTES: usize = LEGACY_MEMORY_MAXIMUM_PAGES * WASM_PAGE_BYTES;
    pub const RESIDENT_MEMORY_INITIAL_PAGES: usize = 720;
    pub const RESIDENT_MEMORY_MAXIMUM_PAGES: usize = 2048;
    pub const RESIDENT_MEMORY_BYTES: usize = RESIDENT_MEMORY_MAXIMUM_PAGES * WASM_PAGE_BYTES;

    // The first MiB is machine-owned control storage.  The legacy browser's CPU image and
    // primary/secondary fast-memory tables currently occupy its lower portion; keeping the
    // resident-dispatch directory in an explicit disjoint reservation lets Rust publish cache
    // metadata without borrowing allocator memory or accepting host-selected pointers.
    pub const DISPATCH_METADATA_OFFSET: usize = 0x0004_0000;
    pub const DISPATCH_METADATA_BYTES: usize = 0x0003_8000;
    pub const DISPATCH_ENTRY_CAPACITY: usize = 4096;
    pub const DISPATCH_SLOT_IDENTITY_OFFSET: usize =
        DISPATCH_METADATA_OFFSET + DISPATCH_METADATA_BYTES;
    pub const DISPATCH_SLOT_IDENTITY_BYTES: usize = 0x0002_0000;
    pub const DISPATCH_SLOT_CAPACITY: usize = 4096;
    /// End of the fixed dispatcher reservation.  The trailing bytes are reserved for the
    /// Rust-owned run outcome, generation, and publication controls added during cutover.
    pub const DISPATCH_RESERVED_END: usize = 0x000a_0000;

    pub const MAIN_RAM_OFFSET: usize = 0x0010_0000;
    pub const MAIN_RAM_BYTES: usize = 0x0180_0000;
    pub const MMIO_OFFSET: usize = MAIN_RAM_OFFSET + MAIN_RAM_BYTES;
    pub const MMIO_BYTES: usize = 0x0002_0000;
    pub const L2C_OFFSET: usize = MMIO_OFFSET + MMIO_BYTES;
    pub const L2C_BYTES: usize = 0x0000_4000;
    pub const MACHINE_RESERVED_END: usize = 0x01a0_0000;
    pub const IPL_OFFSET: usize = MACHINE_RESERVED_END;
    pub const IPL_BYTES: usize = 0x0020_0000;
    pub const ARAM_OFFSET: usize = IPL_OFFSET + IPL_BYTES;
    pub const ARAM_BYTES: usize = 0x0100_0000;
    pub const RUNTIME_BASE: usize = ARAM_OFFSET + ARAM_BYTES;
    pub const LEGACY_RUNTIME_END: usize = LEGACY_MEMORY_BYTES;
    pub const RESIDENT_RUNTIME_END: usize = RESIDENT_MEMORY_BYTES;

    const _: () = assert!(DISPATCH_METADATA_OFFSET.is_multiple_of(16));
    const _: () = assert!(DISPATCH_SLOT_IDENTITY_OFFSET.is_multiple_of(16));
    const _: () = assert!(
        DISPATCH_SLOT_IDENTITY_OFFSET + DISPATCH_SLOT_IDENTITY_BYTES <= DISPATCH_RESERVED_END
    );
    const _: () = assert!(DISPATCH_RESERVED_END <= MAIN_RAM_OFFSET);
    const _: () = assert!(MMIO_OFFSET + MMIO_BYTES <= L2C_OFFSET);
    const _: () = assert!(L2C_OFFSET + L2C_BYTES <= MACHINE_RESERVED_END);
    const _: () = assert!(MACHINE_RESERVED_END == IPL_OFFSET);
    const _: () = assert!(IPL_OFFSET + IPL_BYTES == ARAM_OFFSET);
    const _: () = assert!(ARAM_OFFSET + ARAM_BYTES == RUNTIME_BASE);
    const _: () = assert!(LEGACY_MEMORY_INITIAL_PAGES == RESIDENT_MEMORY_INITIAL_PAGES);
    const _: () = assert!(RUNTIME_BASE < LEGACY_MEMORY_INITIAL_PAGES * WASM_PAGE_BYTES);
    const _: () = assert!(LEGACY_MEMORY_INITIAL_PAGES < LEGACY_MEMORY_MAXIMUM_PAGES);
    const _: () = assert!(RESIDENT_MEMORY_INITIAL_PAGES < RESIDENT_MEMORY_MAXIMUM_PAGES);
    const _: () = assert!(LEGACY_MEMORY_MAXIMUM_PAGES < RESIDENT_MEMORY_MAXIMUM_PAGES);
}

const _: () = assert!(size_of::<RecordHeader>() == 8);
const _: () = assert!(size_of::<SharedPtr>() == 4);
const _: () = assert!(size_of::<SharedSlice>() == 8);
const _: () = assert!(size_of::<PhysicalRange>() == 8);
const _: () = assert!(size_of::<RunOutcome>() == 40);
const _: () = assert!(size_of::<ResidentControl>() == 12);
const _: () = assert!(size_of::<CompileRequest>() == 84);
const _: () = assert!(size_of::<ResidentBlockInstallIdentity>() == 32);
const _: () = assert!(size_of::<BlockInstall>() == 48);
const _: () = assert!(size_of::<HostRequest>() == 52);
const _: () = assert!(size_of::<HostCompletion>() == 40);
const _: () = assert!(size_of::<ViPresentationRequest>() == 80);
const _: () = assert!(size_of::<RenderReceipt>() == 80);
const _: () = assert!(size_of::<EvidenceU64>() == 8);
const _: () = assert!(size_of::<MachineBootEvidenceV1>() == 44);
const _: () = assert!(size_of::<MachineSchedulerEvidenceV1>() == 60);
const _: () = assert!(size_of::<MachineDeviceEvidenceV1>() == 120);
const _: () = assert!(size_of::<MachineDiEvidenceV1>() == 192);
const _: () = assert!(size_of::<MachineGraphicsEvidenceV1>() == 112);
const _: () = assert!(size_of::<MachineRenderEvidenceV1>() == 56);
const _: () = assert!(size_of::<MachineXfbViEvidenceV1>() == 108);
const _: () = assert!(size_of::<MachineSiEvidenceV1>() == 80);
const _: () = assert!(size_of::<MachineEvidenceV1>() == MachineEvidenceV1::BYTE_LEN);
const _: () = assert!(MachineEvidenceV1::BYTE_LEN == 816);
const _: () = assert!(size_of::<DispatchDependency>() == 8);
const _: () = assert!(size_of::<DispatchCacheRecord>() == 56);
const _: () = assert!(size_of::<DispatchSlotIdentityRecord>() == 32);
const _: () = assert!(
    size_of::<DispatchCacheRecord>() * memory::DISPATCH_ENTRY_CAPACITY
        == memory::DISPATCH_METADATA_BYTES
);
const _: () = assert!(
    size_of::<DispatchSlotIdentityRecord>() * memory::DISPATCH_SLOT_CAPACITY
        == memory::DISPATCH_SLOT_IDENTITY_BYTES
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headers_and_layout_are_host_word_size_independent() {
        assert!(RecordHeader::for_record::<CompileRequest>().supports::<CompileRequest>());
        assert_eq!(size_of::<SharedPtr>(), 4);
        assert_eq!(size_of::<RunOutcome>(), 40);
        assert_eq!(size_of::<ResidentControl>(), 12);
        assert_eq!(size_of::<CompileRequest>(), 84);
        assert_eq!(size_of::<ResidentBlockInstallIdentity>(), 32);
        assert_eq!(size_of::<BlockInstall>(), 48);
        assert_eq!(size_of::<HostRequest>(), 52);
        assert_eq!(size_of::<HostCompletion>(), 40);
        assert_eq!(size_of::<ViPresentationRequest>(), 80);
        assert_eq!(size_of::<RenderReceipt>(), 80);
        assert_eq!(size_of::<MachineEvidenceV1>(), 816);
    }

    #[test]
    fn resident_control_preserves_exact_hook_cycle_and_exit_request() {
        let mut control = ResidentControl {
            slice_cycle_prefix: u32::MAX - 4,
            exit_requested: 0,
            instruction_cycle_offset: 9,
        };
        assert_eq!(control.exact_hook_cycle(), u64::from(u32::MAX) + 5);
        assert!(!control.should_exit());
        control.request_exit();
        assert!(control.should_exit());
        control.clear_for_slice();
        assert_eq!(control, ResidentControl::default());
    }

    #[test]
    fn host_written_discriminants_are_checked() {
        let mut outcome = RunOutcome::new(RunReason::BudgetExhausted);
        assert_eq!(outcome.reason(), Ok(RunReason::BudgetExhausted));
        outcome.reason_raw = u32::MAX;
        assert_eq!(outcome.reason(), Err(UnknownDiscriminant(u32::MAX)));

        let completion = HostCompletion {
            header: RecordHeader::for_record::<HostCompletion>(),
            request_id: 7,
            request_nonce_lo: 0,
            request_nonce_hi: 0,
            status_raw: 0xf00d_cafe,
            filled_len: 0,
            reserved: 0,
            value_lo: 0,
            value_hi: 0,
        };
        assert_eq!(completion.status(), Err(UnknownDiscriminant(0xf00d_cafe)));
    }

    #[test]
    fn physical_range_overlap_is_wrap_safe() {
        let wrapped = PhysicalRange {
            start: 0xffff_fff0,
            len: 0x20,
        };
        assert!(wrapped.contains(0xffff_ffff));
        assert!(wrapped.contains(0));
        assert!(wrapped.overlaps(PhysicalRange { start: 4, len: 4 }));
        assert!(!wrapped.overlaps(PhysicalRange {
            start: 0x100,
            len: 4,
        }));
    }

    #[test]
    fn install_and_completion_receipts_require_exact_rust_identity() {
        let compile = CompileRequest {
            header: RecordHeader::for_record::<CompileRequest>(),
            request_id: 17,
            table_slot: 91,
            slot_nonce_lo: 5,
            slot_nonce_hi: 6,
            address_space_generation_lo: 7,
            address_space_generation_hi: 8,
            install_token_lo: 9,
            install_token_hi: 10,
            module: SharedSlice {
                ptr: SharedPtr(0x2000),
                len: 4096,
            },
            module_sha256: [0x1234_5678; 8],
            reserved: 0,
        };
        let mut install = BlockInstall {
            header: RecordHeader::for_record::<BlockInstall>(),
            request_id: compile.request_id,
            table_index: compile.table_slot,
            slot_nonce_lo: compile.slot_nonce_lo,
            slot_nonce_hi: compile.slot_nonce_hi,
            address_space_generation_lo: compile.address_space_generation_lo,
            address_space_generation_hi: compile.address_space_generation_hi,
            install_token_lo: compile.install_token_lo,
            install_token_hi: compile.install_token_hi,
            status_raw: BlockInstallStatus::Installed as u32,
            reserved: 0,
        };
        assert!(compile.has_valid_source());
        assert!(compile.install_identity().matches_request(&compile));
        assert!(install.matches_request_identity(&compile));
        assert!(install.is_installed_for(&compile));
        assert_eq!(install.status(), Ok(BlockInstallStatus::Installed));
        let mut invalid_source = compile;
        invalid_source.module = SharedSlice {
            ptr: SharedPtr(u32::MAX),
            len: 2,
        };
        assert!(!invalid_source.has_valid_source());
        install.slot_nonce_hi ^= 1;
        assert!(!install.matches_request_identity(&compile));

        let request = HostRequest {
            header: RecordHeader::for_record::<HostRequest>(),
            request_id: 23,
            request_nonce_lo: 10,
            request_nonce_hi: 11,
            kind_raw: HostRequestKind::DiscRead as u32,
            flags: 0,
            address: 0,
            length: 0,
            payload: SharedSlice {
                ptr: SharedPtr(0x1000),
                len: 32,
            },
            arg0: 0,
            arg1: 0,
        };
        let mut completion = HostCompletion {
            header: RecordHeader::for_record::<HostCompletion>(),
            request_id: request.request_id,
            request_nonce_lo: request.request_nonce_lo,
            request_nonce_hi: request.request_nonce_hi,
            status_raw: HostCompletionStatus::Ok as u32,
            filled_len: 12,
            reserved: 0,
            value_lo: 0,
            value_hi: 0,
        };
        assert!(completion.matches_request_identity(&request));
        assert_eq!(
            completion.checked_filled_slice(&request),
            Some(SharedSlice {
                ptr: SharedPtr(0x1000),
                len: 12,
            })
        );
        completion.filled_len = 33;
        assert_eq!(completion.checked_filled_slice(&request), None);
        completion.filled_len = 12;
        completion.request_nonce_lo ^= 1;
        assert!(!completion.matches_request_identity(&request));
    }

    #[test]
    fn render_receipt_has_checked_canonical_little_endian_shape() {
        let mut receipt = RenderReceipt::new(
            0x8877_6655_4433_2211,
            RenderReceiptKind::XfbCopy,
            RenderReceiptStatus::Completed,
            93,
        );
        receipt.flags = RENDER_RECEIPT_HAS_PRESENTATION;
        receipt.presentation_epoch = 7;
        receipt.presentation_width = 640;
        receipt.presentation_height = 448;
        receipt.presentation_serial_lo = 11;
        receipt.presentation_status_raw = RenderPresentationStatus::Presented as u32;
        assert!(receipt.has_canonical_shape());

        let mut bytes = [0u8; RenderReceipt::BYTE_LEN];
        assert!(receipt.encode_le(&mut bytes));
        assert_eq!(RenderReceipt::decode_le(&bytes), Some(receipt));
        assert_eq!(
            RenderReceipt::decode_le(&bytes).unwrap().sequence(),
            0x8877_6655_4433_2211
        );

        let mut malformed = receipt;
        malformed.flags = 0;
        assert!(!malformed.has_canonical_shape());
        malformed = receipt;
        malformed.kind_raw = u32::MAX;
        assert!(!malformed.has_canonical_shape());
        malformed = receipt;
        malformed.reserved[3] = 1;
        assert!(!malformed.has_canonical_shape());
        malformed = receipt;
        malformed.header.byte_len += 4;
        assert!(!malformed.has_canonical_shape());
        assert_eq!(
            RenderReceipt::decode_le(&bytes[..RenderReceipt::BYTE_LEN - 1]),
            None
        );
    }

    #[test]
    fn vi_presentation_request_is_exact_integer_only_payload() {
        let request = ViPresentationRequest::new(
            19,
            0x0012_0000,
            7,
            2,
            ViPresentationMode::Interlaced,
            ViFieldParity::Bottom,
            11,
            640,
            448,
            1280,
            224,
            2,
            true,
        );
        assert!(request.has_canonical_shape());
        assert_eq!(request.sequence(), 19);
        assert!(request.pair_completing());
        let mut bytes = [0u8; ViPresentationRequest::BYTE_LEN];
        assert!(request.encode_le(&mut bytes));
        assert_eq!(ViPresentationRequest::decode_le(&bytes), Some(request));
        assert_eq!(&bytes[0..4], &ABI_VERSION.to_le_bytes());
        assert_eq!(
            &bytes[4..8],
            &(ViPresentationRequest::BYTE_LEN as u32).to_le_bytes()
        );

        let mut malformed = request;
        malformed.mode_raw = u32::MAX;
        assert!(!malformed.has_canonical_shape());
        malformed = request;
        malformed.flags |= 2;
        assert!(!malformed.has_canonical_shape());
        assert_eq!(
            ViPresentationRequest::decode_le(&bytes[..ViPresentationRequest::BYTE_LEN - 1]),
            None
        );
    }

    #[test]
    fn machine_evidence_v1_has_exact_versioned_816_byte_encoding() {
        let record = MachineEvidenceV1::new(0x8877_6655_4433_2211, 0x0102_0304_0506_0708);
        assert!(record.has_canonical_shape());
        assert_eq!(MachineEvidenceV1::WORD_LEN, 204);
        assert_eq!(MachineEvidenceV1::BYTE_LEN, 816);

        let mut bytes = [0xa5; MachineEvidenceV1::BYTE_LEN];
        assert!(record.encode_le(&mut bytes));
        let mut expected = [0_u8; MachineEvidenceV1::BYTE_LEN];
        let prefix = [
            ABI_VERSION,
            MachineEvidenceV1::BYTE_LEN as u32,
            MACHINE_EVIDENCE_V1_TAG,
            0,
            0x4433_2211,
            0x8877_6655,
            0x0506_0708,
            0x0102_0304,
        ];
        for (destination, word) in expected.chunks_exact_mut(4).zip(prefix) {
            destination.copy_from_slice(&word.to_le_bytes());
        }
        assert_eq!(bytes, expected);
        assert_eq!(MachineEvidenceV1::decode_le(&bytes), Some(record));
        assert_eq!(
            MachineEvidenceV1::decode_le(&bytes[..MachineEvidenceV1::BYTE_LEN - 1]),
            None
        );

        let mut wrong_version = bytes;
        wrong_version[0..4].copy_from_slice(&(ABI_VERSION + 1).to_le_bytes());
        assert_eq!(MachineEvidenceV1::decode_le(&wrong_version), None);
        assert!(!MachineEvidenceV1::new(0, 1).has_canonical_shape());
        assert!(!MachineEvidenceV1::new(1, 0).has_canonical_shape());
    }

    #[test]
    fn evidence_u64_orders_the_numeric_value_across_low_word_rollover() {
        let values = [
            0,
            1,
            u64::from(u32::MAX) - 1,
            u64::from(u32::MAX),
            u64::from(u32::MAX) + 1,
            u64::from(u32::MAX) + 2,
            u64::MAX - 1,
            u64::MAX,
        ];
        for left in values {
            for right in values {
                assert_eq!(
                    EvidenceU64::new(left).cmp(&EvidenceU64::new(right)),
                    left.cmp(&right),
                );
            }
        }
    }

    #[test]
    fn machine_di_evidence_requires_exact_command_and_host_balances() {
        let mut di = MachineDiEvidenceV1::new();
        assert!(di.has_canonical_shape());

        di.current_state_raw = MachineDiLifecycleState::StartPending as u32;
        di.current_kind_raw = MachineDiCommandKind::Inquiry as u32;
        assert!(di.has_canonical_shape());
        di.command_starts = EvidenceU64::new(1);
        assert!(!di.has_canonical_shape());

        let mut rejected = MachineDiEvidenceV1::new();
        rejected.command_start_rejections = EvidenceU64::new(1);
        rejected.read_start_rejections = EvidenceU64::new(1);
        assert!(rejected.has_canonical_shape());
        rejected.inquiry_start_rejections = EvidenceU64::new(1);
        assert!(!rejected.has_canonical_shape());

        di.inquiry_starts = EvidenceU64::new(1);
        di.current_state_raw = MachineDiLifecycleState::AwaitingDeadline as u32;
        assert!(di.has_canonical_shape());
        di.current_state_raw = MachineDiLifecycleState::Idle as u32;
        di.current_kind_raw = MachineDiCommandKind::None as u32;
        di.command_cancellations = EvidenceU64::new(1);
        di.inquiry_cancellations = EvidenceU64::new(1);
        assert!(di.has_canonical_shape());

        di = MachineDiEvidenceV1::new();
        di.command_starts = EvidenceU64::new(1);
        di.read_starts = EvidenceU64::new(1);
        di.read_sector_starts = EvidenceU64::new(1);
        di.current_state_raw = MachineDiLifecycleState::AwaitingHost as u32;
        di.current_kind_raw = MachineDiCommandKind::ReadSector as u32;
        // A logical read can await mapper preparation before a physical request exists.
        assert!(di.has_canonical_shape());

        di.physical_host_requests_issued = EvidenceU64::new(1);
        assert!(!di.has_canonical_shape());
        di.physical_host_request_pending = 1;
        assert!(di.has_canonical_shape());
        // Rejected attempts never retire the authentic request.
        di.host_receipts_rejected = EvidenceU64::new(3);
        assert!(di.has_canonical_shape());
        di.physical_host_request_pending = 0;
        di.host_receipts_succeeded = EvidenceU64::new(1);
        di.current_state_raw = MachineDiLifecycleState::ReadReady as u32;
        assert!(di.has_canonical_shape());

        di.command_completions = EvidenceU64::new(1);
        di.read_completions = EvidenceU64::new(1);
        di.current_state_raw = MachineDiLifecycleState::Idle as u32;
        di.current_kind_raw = MachineDiCommandKind::None as u32;
        assert!(di.has_canonical_shape());

        let mut record = MachineEvidenceV1::new(7, 11);
        record.di = di;
        let mut bytes = [0_u8; MachineEvidenceV1::BYTE_LEN];
        assert!(record.encode_le(&mut bytes));
        assert_eq!(MachineEvidenceV1::decode_le(&bytes), Some(record));
        let word = |index: usize| {
            let offset = index * size_of::<u32>();
            u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
        };
        assert_eq!(word(156), 1);
        assert_eq!(word(158), 1);
        assert_eq!(word(160), 0);
        assert_eq!(word(172), 1);
        assert_eq!(word(178), 1);
        assert_eq!(word(186), 1);
        assert_eq!(word(190), 1);
        assert_eq!(word(194), 3);
        assert_eq!(word(200), MachineDiLifecycleState::Idle as u32);

        di.command_cancellations = EvidenceU64::new(u64::MAX);
        assert!(!di.has_canonical_shape());
    }

    #[test]
    fn machine_evidence_v1_checks_xfb_vi_si_and_renderer_chronology() {
        let mut record = MachineEvidenceV1::new(7, 9);
        record.flags = MACHINE_EVIDENCE_DSP_LLE_VALID
            | MACHINE_EVIDENCE_HAS_XFB_VI
            | MACHINE_EVIDENCE_HAS_SI_PUBLICATION
            | MACHINE_EVIDENCE_HAS_BOOT_IDENTITY;
        record.boot = MachineBootEvidenceV1 {
            boot_epoch: EvidenceU64::new(3),
            logical_bytes: EvidenceU64::new(889_225_792),
            identifier_be_words: [u32::from_be_bytes(*b"GZWE"), u32::from_be_bytes(*b"01\0\0")],
            status_raw: MachineBootStatus::Committed as u32,
            fault_raw: MachineBootFault::None as u32,
            revision: 0,
            disc_number: 0,
            format_raw: MachineDiscFormat::Ciso as u32,
        };
        record.scheduler.canonical_cycle = EvidenceU64::new(1_000);
        record.scheduler.executed_cycles = EvidenceU64::new(900);
        record.scheduler.executed_instructions = EvidenceU64::new(400);
        record.scheduler.address_space_generation = EvidenceU64::new(2);
        record.scheduler.retired_blocks = EvidenceU64::new(10);
        record.scheduler.completed_outer_slices = EvidenceU64::new(4);
        record.scheduler.pc = 0x8000_3100;
        record.graphics.xfb_copies = EvidenceU64::new(1);
        record.graphics.presented_frames = EvidenceU64::new(1);
        record.renderer.render_requests_issued = EvidenceU64::new(3);
        record.renderer.render_completions_authenticated = EvidenceU64::new(3);
        record.renderer.render_high_water = 1;
        record.xfb_vi = MachineXfbViEvidenceV1 {
            xfb_completion_cycle: EvidenceU64::new(700),
            vi_selection_cycle: EvidenceU64::new(800),
            render_completion_cycle: EvidenceU64::new(900),
            render_sequence: EvidenceU64::new(3),
            presentation_serial: EvidenceU64::new(11),
            xfb_generation: 4,
            selected_row: 0,
            mode_raw: ViPresentationMode::Progressive as u32,
            parity_raw: ViFieldParity::Top as u32,
            pair_epoch: 2,
            xfb_width: 640,
            xfb_height: 448,
            xfb_stride: 1_280,
            output_width: 640,
            output_height: 448,
            field_stride_bytes: 1_280,
            field_height: 448,
            row_repeat: 1,
            presentation_status_raw: RenderPresentationStatus::Presented as u32,
            presentation_width: 640,
            presentation_height: 448,
            flags: MACHINE_XFB_VI_PAIR_COMPLETING,
        };
        record.si = MachineSiEvidenceV1 {
            poll_index: EvidenceU64::new(5),
            scheduled_cycle: EvidenceU64::new(850),
            observed_cycle: EvidenceU64::new(851),
            last_received_sequence: EvidenceU64::new(2),
            applied_sequence: EvidenceU64::new(2),
            periodic_polls: EvidenceU64::new(5),
            direct_polls: EvidenceU64::new(0),
            backpressured_polls: EvidenceU64::new(1),
            packet_be_words: [0x0180_0080, 0x8000_0000],
            queue_depth: 0,
            source_raw: MachineSiPollSource::Periodic as u32,
        };
        assert!(record.has_canonical_shape());

        // Retained XFB and SI chronology plus semantic-idle accounting remain earlier than the
        // scheduler when its low word rolls over. The split representation must compare the
        // complete numeric u64, not the `lo` field before `hi`.
        let rollover_cycle = u64::from(u32::MAX) + 1;
        let mut rollover = record;
        rollover.scheduler.canonical_cycle = EvidenceU64::new(rollover_cycle);
        rollover.scheduler.executed_cycles = EvidenceU64::new(rollover_cycle);
        rollover.xfb_vi.render_completion_cycle = EvidenceU64::new(rollover_cycle - 3);
        rollover.si.scheduled_cycle = EvidenceU64::new(rollover_cycle - 2);
        rollover.si.observed_cycle = EvidenceU64::new(rollover_cycle - 1);
        rollover.semantic_idle_cycles = EvidenceU64::new(rollover_cycle - 4);
        rollover.semantic_idle_jumps = 1;
        assert!(rollover.has_canonical_shape());

        let mut bytes = [0_u8; MachineEvidenceV1::BYTE_LEN];
        assert!(record.encode_le(&mut bytes));
        assert_eq!(MachineEvidenceV1::decode_le(&bytes), Some(record));
        let word = |index: usize| {
            let offset = index * 4;
            u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
        };
        assert_eq!(word(1), 816);
        assert_eq!(word(12), u32::from_be_bytes(*b"GZWE"));
        assert_eq!(word(13), u32::from_be_bytes(*b"01\0\0"));
        assert_eq!(word(31), 0x8000_3100);
        assert_eq!(word(32), 0);
        assert_eq!(word(116), 4);
        assert_eq!(word(149), 0x0180_0080);
        assert_eq!(word(150), 0x8000_0000);
        assert_eq!(word(153), 0);
        assert_eq!(word(155), 0);

        let mut malformed = record;
        malformed.xfb_vi.render_completion_cycle = EvidenceU64::new(799);
        assert!(!malformed.has_canonical_shape());
        malformed = record;
        malformed.xfb_vi.presentation_serial = EvidenceU64::new(0);
        assert!(!malformed.has_canonical_shape());
        malformed = record;
        malformed.si.source_raw = u32::MAX;
        assert!(!malformed.has_canonical_shape());
        malformed = record;
        malformed.renderer.render_pending = 1;
        assert!(!malformed.has_canonical_shape());
        malformed = record;
        malformed.flags &= !MACHINE_EVIDENCE_HAS_XFB_VI;
        assert!(!malformed.has_canonical_shape());
    }

    #[test]
    fn dispatcher_records_are_rust_built_and_publish_identity_last() {
        let dependencies = [
            DispatchDependency {
                effective_page: 0x8000_1000,
                physical_page: 0x0000_2000,
            },
            DispatchDependency {
                effective_page: 0x8000_2000,
                physical_page: 0x0000_3000,
            },
        ];
        let record = DispatchCacheRecord::unpublished_basic_block(
            0x8000_1ff0,
            0x1122_3344_5566_7788,
            7,
            0x8877_6655_4433_2211,
            19,
            5,
            &dependencies,
        )
        .unwrap();
        assert_eq!(record.state, 0);
        assert_eq!(record.kind, DISPATCH_BASIC_BLOCK_KIND);
        assert_eq!(record.address_space_generation(), 0x1122_3344_5566_7788);
        assert_eq!(record.slot_nonce(), 0x8877_6655_4433_2211);
        assert_eq!(record.maximum_cycles(), 19);
        assert_eq!(record.maximum_instructions(), 5);
        assert_eq!(record.dependency_count, 2);
        assert_eq!(record.dependencies, dependencies);
        assert_eq!(record.published().state, DISPATCH_ENTRY_READY);

        let identity = DispatchSlotIdentityRecord::unpublished(
            record.pc,
            record.address_space_generation(),
            record.slot_nonce(),
        );
        assert_eq!(identity.state, 0);
        assert_eq!(identity.reserved, [0; 2]);
        assert_eq!(identity.published().state, DISPATCH_SLOT_READY);

        assert!(DispatchCacheRecord::unpublished_basic_block(2, 1, 0, 1, 1, 1, &[]).is_none());
        assert!(
            DispatchCacheRecord::unpublished_basic_block(
                0,
                1,
                0,
                1,
                1,
                1,
                &[DispatchDependency {
                    effective_page: 1,
                    physical_page: 0,
                }],
            )
            .is_none()
        );
    }

    #[test]
    fn fixed_memory_layout_keeps_machine_regions_disjoint() {
        use memory::*;

        assert_eq!(MAIN_RAM_OFFSET + MAIN_RAM_BYTES, MMIO_OFFSET);
        assert_eq!(MMIO_OFFSET + MMIO_BYTES, L2C_OFFSET);
        assert_eq!(MACHINE_RESERVED_END, IPL_OFFSET);
        assert_eq!(IPL_OFFSET + IPL_BYTES, ARAM_OFFSET);
        assert_eq!(ARAM_OFFSET + ARAM_BYTES, RUNTIME_BASE);
        assert_eq!(LEGACY_RUNTIME_END - RUNTIME_BASE, 4 * 1024 * 1024);
        assert_eq!(RESIDENT_RUNTIME_END - RUNTIME_BASE, 84 * 1024 * 1024);
        assert_eq!(LEGACY_MEMORY_BYTES, 48 * 1024 * 1024);
        assert_eq!(RESIDENT_MEMORY_BYTES, 128 * 1024 * 1024);
        assert_eq!(DISPATCH_ENTRY_CAPACITY, 4096);
        assert_eq!(DISPATCH_SLOT_CAPACITY, 4096);
        assert_eq!(DISPATCH_METADATA_OFFSET + DISPATCH_METADATA_BYTES, 0x78000);
        assert_eq!(
            DISPATCH_SLOT_IDENTITY_OFFSET + DISPATCH_SLOT_IDENTITY_BYTES,
            0x98000
        );
    }
}
