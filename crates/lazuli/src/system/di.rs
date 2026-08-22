//! Disk interface (DI).
//!
//! The resident path in this module deliberately owns command decoding, emulated timing, async
//! read identity, staging, and completion effects. A browser adapter may fill the exact staging
//! window named by [`DiscReadRequest`], but it cannot choose when a command completes or mutate
//! MEM1/register state directly. The older native `DiskModule` adapter at the end of the file is
//! transitional and is not part of the resident authority.

use std::io::SeekFrom;

use bitos::{BitUtils, bitos};
use gekko::{Address, LoadStoreReservation};
use strum::FromRepr;

use crate::system::mem::RAM_LEN;
use crate::system::scheduler::{MachineEventDeadlines, MachineEventKind};
use crate::system::{System, ai, pi};

pub const DMA_ADDRESS_MASK: u32 = 0x03ff_ffe0;
pub const DMA_LENGTH_MASK: u32 = 0xffff_ffe0;
pub const DMA_CONTROL_MASK: u32 = 0x0000_0007;
pub const MINIMUM_COMMAND_LATENCY_CYCLES: u64 = 145_800;
pub const READ_START_LATENCY_CYCLES: u64 = 291_600;
pub const BUFFER_TRANSFER_BYTES_PER_SECOND: u64 = 32 * 1024 * 1024;
pub const CPU_CYCLES_PER_SECOND: u64 = 486_000_000;
pub const DVD_ECC_BLOCK_BYTES: u64 = 0x8000;

pub const ERROR_NONE: u32 = 0x0000_0000;
pub const ERROR_READ: u32 = 0x0003_1100;
pub const ERROR_INVALID_COMMAND: u32 = 0x0005_2000;
pub const ERROR_BLOCK_OUT_OF_BOUNDS: u32 = 0x0005_2100;
pub const ERROR_NO_AUDIO_BUFFER: u32 = 0x0005_2001;
pub const ERROR_INVALID_AUDIO_COMMAND: u32 = 0x0005_2401;

pub const INQUIRY_COMPATIBILITY_BYTES: [u8; 12] = [
    0x00, 0x00, 0x00, 0x02, 0x20, 0x06, 0x05, 0x26, 0x41, 0x00, 0x00, 0x00,
];

/// Maximum size of one asynchronous host read issued by resident DI.
pub const MAX_DISC_READ_CHUNK_BYTES: u32 = 256 * 1024;
/// Maximum requested heap backing for an atomic resident DI transfer.
///
/// A legal transfer must fit wholly in MEM1, so the Rust-private payload is bounded by 24 MiB.
/// Only a subrange of at most [`MAX_DISC_READ_CHUNK_BYTES`] is lent to the adapter at once; that
/// window aliases this payload and does not require a second allocation.
pub const MAX_RESIDENT_DI_PAYLOAD_BYTES: usize = RAM_LEN;
/// Fixed scalar footprint, excluding the one private payload allocation.
pub const RESIDENT_DI_SCALAR_STATE_BYTES: usize = std::mem::size_of::<ResidentState>();
const _: () = assert!(RESIDENT_DI_SCALAR_STATE_BYTES < 1024);

pub const AUDIO_BATCH_CYCLES: u64 = 1_699_488;

#[bitos(32)]
#[derive(Debug, Clone, Copy, Default)]
pub struct Status {
    #[bits(0)]
    pub break_request: bool,
    #[bits(1)]
    pub device_err_interrupt_mask: bool,
    #[bits(2)]
    pub device_err_interrupt: bool,
    #[bits(3)]
    pub transfer_interrupt_mask: bool,
    #[bits(4)]
    pub transfer_interrupt: bool,
    #[bits(5)]
    pub break_interrupt_mask: bool,
    #[bits(6)]
    pub break_interrupt: bool,
}

impl Status {
    #[must_use]
    pub fn any_interrupt(&self) -> bool {
        let device_err = self.device_err_interrupt() && self.device_err_interrupt_mask();
        let transfer = self.transfer_interrupt() && self.transfer_interrupt_mask();
        let break_ = self.break_interrupt() && self.break_interrupt_mask();
        device_err || transfer || break_
    }

    #[cfg(test)]
    fn raw(self) -> u32 {
        u32::from(self.break_request())
            | (u32::from(self.device_err_interrupt_mask()) << 1)
            | (u32::from(self.device_err_interrupt()) << 2)
            | (u32::from(self.transfer_interrupt_mask()) << 3)
            | (u32::from(self.transfer_interrupt()) << 4)
            | (u32::from(self.break_interrupt_mask()) << 5)
            | (u32::from(self.break_interrupt()) << 6)
    }
}

#[bitos(1)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferMode {
    Read  = 0,
    Write = 1,
}

#[bitos(32)]
#[derive(Debug, Clone, Copy, Default)]
pub struct Control {
    #[bits(0)]
    pub transfer_ongoing: bool,
    #[bits(1)]
    pub dma: bool,
    #[bits(2)]
    pub mode: TransferMode,
}

#[bitos(32)]
#[derive(Debug, Clone, Copy, Default)]
pub struct Cover {
    #[bits(0)]
    pub open: bool,
    #[bits(1)]
    pub interrupt_mask: bool,
    #[bits(2)]
    pub interrupt: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, FromRepr)]
#[repr(u8)]
pub enum Opcode {
    Identify    = 0x12,
    Read        = 0xA8,
    Seek        = 0xAB,
    Status      = 0xE0,
    AudioStream = 0xE1,
    AudioStatus = 0xE2,
    StopMotor   = 0xE3,
    AudioConfig = 0xE4,
    Debug       = 0xFE,
    DebugEnable = 0xFF,
}

impl Opcode {
    #[must_use]
    pub fn new(value: u8) -> Option<Self> {
        Opcode::from_repr(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Identify,
    Read { offset: u32, length: u32 },
    Seek { offset: u32 },
    Status,
    StartAudioStream { offset: u32, length: u32 },
    StopAudioStream,
    AudioStreamStatus,
    StopMotor,
    DisableAudioStream,
    EnableAudioStream,
    Debug,
    DebugEnable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandDecodeError {
    UnknownOpcode(u8),
    InvalidReadDiscId,
    InvalidAudioStream(u8),
    InvalidAudioStatus(u8),
    InvalidAudioConfig { subcommand: u8, field: u8 },
}

/// Complete identity of one Rust-issued logical-disc read window.
///
/// `epoch` invalidates completions from a prior disc/reset generation. `id` is never reused in an
/// epoch, and the offset/length fields must also be echoed exactly. Requests are sequential and
/// never exceed [`MAX_DISC_READ_CHUNK_BYTES`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(C)]
pub struct DiscReadRequest {
    pub epoch: u64,
    pub id: u64,
    pub disc_offset: u64,
    pub length: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResidentCommandKind {
    Inquiry,
    ReadSector,
    ReadDiscId,
    Seek,
    RequestError,
    AudioStream,
    AudioStatus,
    StopMotor,
    AudioConfig,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResidentCommandStart {
    pub kind: ResidentCommandKind,
    pub completion_cycle: u64,
    pub read_request: Option<DiscReadRequest>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResidentStartError {
    Busy {
        completion_cycle: u64,
    },
    StartPending,
    InvalidControlMode {
        control: u32,
    },
    UnsupportedDmaCommand {
        command0: u32,
    },
    InvalidReadSubcommand(u8),
    InvalidInquiryLength(u32),
    ZeroRequestedLength,
    ZeroDmaLength,
    Mem1Range {
        dma_address: u32,
        length: u32,
        valid_prefix_bytes: u32,
    },
    DiscRangeUnknown,
    DiscRangeOverflow,
    CycleOverflow,
    RequestIdExhausted,
    PayloadAllocationFailed {
        length: u32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResidentRegisterWriteError {
    Busy { completion_cycle: u64 },
    StartPending,
    InvalidCommandWord(u8),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResidentDiscConfigError {
    Busy { completion_cycle: u64 },
    StartPending,
    EpochExhausted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResidentResetError {
    EpochExhausted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResidentAudioScheduleError {
    CycleOverflow,
}

/// Diagnostic identity of the most recent resident DI reset.
///
/// The value may wrap. Consumers that must not miss a reset use
/// [`Interface::take_resident_reset`] instead of comparing generations: its independent pending
/// latch remains asserted across wrap and coalesces repeated, idempotent resets until observed.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ResidentResetGeneration(u64);

impl ResidentResetGeneration {
    #[must_use]
    pub const fn value(self) -> u64 {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscReadCompletionError {
    NoPendingRead,
    StaleRequest {
        id: u64,
    },
    UnknownRequest {
        id: u64,
    },
    OutOfOrderRequest {
        expected: DiscReadRequest,
        received: DiscReadRequest,
    },
    DescriptorMismatch {
        expected: DiscReadRequest,
        received: DiscReadRequest,
    },
    ResultAlreadyProvided {
        request: DiscReadRequest,
    },
    ShortRead {
        request: DiscReadRequest,
        written: u32,
    },
    OverlongRead {
        request: DiscReadRequest,
        written: u32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResidentServiceState {
    Idle,
    BeforeDeadline {
        completion_cycle: u64,
    },
    WaitingForHost {
        completion_cycle: u64,
        request: DiscReadRequest,
    },
    Completed(ResidentCompletion),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResidentCompletion {
    pub kind: ResidentCommandKind,
    pub completion_cycle: u64,
    pub serviced_at_cycle: u64,
    pub successful: bool,
    pub interrupt_status: u32,
    pub error_code: u32,
    pub memory_write_bytes: u32,
    pub reservation_invalidated: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ResidentAudioService {
    pub batches: u64,
    pub blocks: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResidentServiceSummary {
    pub audio: ResidentAudioService,
    pub command: ResidentServiceState,
    pub interrupt_level: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ResidentDeadlines {
    pub completion: Option<u64>,
    pub audio: Option<u64>,
}

/// Current Rust-owned phase of the resident DI command lifecycle.
///
/// This is diagnostic state only. It is derived at the same acceptance points that mutate the
/// device and never contains command words, DMA addresses, disc offsets, or payload bytes.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum ResidentDiLifecycleState {
    #[default]
    Idle,
    StartPending,
    AwaitingDeadline,
    AwaitingHost,
    ReadReady,
}

/// Copy-only cumulative resident-DI evidence for one `Interface` lifetime.
///
/// Counter overflow poisons this evidence stream permanently. Device execution continues with its
/// normal typed result so diagnostic accounting can never alter guest-visible behavior.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ResidentDiLifecycleEvidence {
    pub command_starts: u64,
    pub command_completions: u64,
    pub command_cancellations: u64,
    pub command_start_rejections: u64,
    pub inquiry_starts: u64,
    pub inquiry_completions: u64,
    pub inquiry_cancellations: u64,
    pub inquiry_start_rejections: u64,
    pub read_starts: u64,
    pub read_sector_starts: u64,
    pub read_disc_id_starts: u64,
    pub read_completions: u64,
    pub read_cancellations: u64,
    pub read_start_rejections: u64,
    pub read_device_failures: u64,
    pub current_state: ResidentDiLifecycleState,
    pub current_kind: Option<ResidentCommandKind>,
}

#[derive(Debug)]
struct ResidentDiLifecycle {
    evidence: ResidentDiLifecycleEvidence,
    healthy: bool,
}

impl Default for ResidentDiLifecycle {
    fn default() -> Self {
        Self {
            evidence: ResidentDiLifecycleEvidence::default(),
            healthy: true,
        }
    }
}

impl ResidentDiLifecycle {
    fn add(&mut self, select: impl FnOnce(&mut ResidentDiLifecycleEvidence) -> &mut u64) {
        if !self.healthy {
            return;
        }
        let counter = select(&mut self.evidence);
        let Some(next) = counter.checked_add(1) else {
            self.healthy = false;
            return;
        };
        *counter = next;
    }

    fn begin_start(&mut self, kind: ResidentCommandKind) {
        self.evidence.current_state = ResidentDiLifecycleState::StartPending;
        self.evidence.current_kind = Some(kind);
    }

    fn accept_start(&mut self, start: ResidentCommandStart) {
        self.add(|evidence| &mut evidence.command_starts);
        match start.kind {
            ResidentCommandKind::Inquiry => {
                self.add(|evidence| &mut evidence.inquiry_starts);
            }
            ResidentCommandKind::ReadSector => {
                self.add(|evidence| &mut evidence.read_starts);
                self.add(|evidence| &mut evidence.read_sector_starts);
            }
            ResidentCommandKind::ReadDiscId => {
                self.add(|evidence| &mut evidence.read_starts);
                self.add(|evidence| &mut evidence.read_disc_id_starts);
            }
            ResidentCommandKind::Seek
            | ResidentCommandKind::RequestError
            | ResidentCommandKind::AudioStream
            | ResidentCommandKind::AudioStatus
            | ResidentCommandKind::StopMotor
            | ResidentCommandKind::AudioConfig
            | ResidentCommandKind::Unsupported => {}
        }
        self.evidence.current_kind = Some(start.kind);
        self.evidence.current_state = if start.read_request.is_some() {
            ResidentDiLifecycleState::AwaitingHost
        } else {
            ResidentDiLifecycleState::AwaitingDeadline
        };
    }

    fn reject_start(&mut self, kind: ResidentCommandKind, clear_current: bool) {
        self.add(|evidence| &mut evidence.command_start_rejections);
        match kind {
            ResidentCommandKind::Inquiry => {
                self.add(|evidence| &mut evidence.inquiry_start_rejections);
            }
            ResidentCommandKind::ReadSector | ResidentCommandKind::ReadDiscId => {
                self.add(|evidence| &mut evidence.read_start_rejections);
            }
            ResidentCommandKind::Seek
            | ResidentCommandKind::RequestError
            | ResidentCommandKind::AudioStream
            | ResidentCommandKind::AudioStatus
            | ResidentCommandKind::StopMotor
            | ResidentCommandKind::AudioConfig
            | ResidentCommandKind::Unsupported => {}
        }
        if clear_current {
            self.evidence.current_state = ResidentDiLifecycleState::Idle;
            self.evidence.current_kind = None;
        }
    }

    fn read_ready(&mut self) {
        if matches!(
            self.evidence.current_kind,
            Some(ResidentCommandKind::ReadSector | ResidentCommandKind::ReadDiscId)
        ) {
            self.evidence.current_state = ResidentDiLifecycleState::ReadReady;
        } else {
            self.healthy = false;
        }
    }

    fn read_window_pending(&mut self) {
        if matches!(
            self.evidence.current_kind,
            Some(ResidentCommandKind::ReadSector | ResidentCommandKind::ReadDiscId)
        ) {
            self.evidence.current_state = ResidentDiLifecycleState::AwaitingHost;
        } else {
            self.healthy = false;
        }
    }

    fn accept_completion(&mut self, completion: ResidentCompletion) {
        self.add(|evidence| &mut evidence.command_completions);
        match completion.kind {
            ResidentCommandKind::Inquiry => {
                self.add(|evidence| &mut evidence.inquiry_completions);
            }
            ResidentCommandKind::ReadSector | ResidentCommandKind::ReadDiscId => {
                self.add(|evidence| &mut evidence.read_completions);
                if !completion.successful {
                    self.add(|evidence| &mut evidence.read_device_failures);
                }
            }
            ResidentCommandKind::Seek
            | ResidentCommandKind::RequestError
            | ResidentCommandKind::AudioStream
            | ResidentCommandKind::AudioStatus
            | ResidentCommandKind::StopMotor
            | ResidentCommandKind::AudioConfig
            | ResidentCommandKind::Unsupported => {}
        }
        if self.evidence.current_kind != Some(completion.kind) {
            self.healthy = false;
        }
        self.evidence.current_state = ResidentDiLifecycleState::Idle;
        self.evidence.current_kind = None;
    }

    fn cancel_current(&mut self) {
        if matches!(
            self.evidence.current_state,
            ResidentDiLifecycleState::AwaitingDeadline
                | ResidentDiLifecycleState::AwaitingHost
                | ResidentDiLifecycleState::ReadReady
        ) {
            self.add(|evidence| &mut evidence.command_cancellations);
            match self.evidence.current_kind {
                Some(ResidentCommandKind::Inquiry) => {
                    self.add(|evidence| &mut evidence.inquiry_cancellations);
                }
                Some(ResidentCommandKind::ReadSector | ResidentCommandKind::ReadDiscId) => {
                    self.add(|evidence| &mut evidence.read_cancellations);
                }
                Some(
                    ResidentCommandKind::Seek
                    | ResidentCommandKind::RequestError
                    | ResidentCommandKind::AudioStream
                    | ResidentCommandKind::AudioStatus
                    | ResidentCommandKind::StopMotor
                    | ResidentCommandKind::AudioConfig
                    | ResidentCommandKind::Unsupported,
                )
                | None => {}
            }
        }
        self.evidence.current_state = ResidentDiLifecycleState::Idle;
        self.evidence.current_kind = None;
    }

    fn clear_unaccepted_start(&mut self) {
        match self.evidence.current_state {
            ResidentDiLifecycleState::Idle | ResidentDiLifecycleState::StartPending => {}
            ResidentDiLifecycleState::AwaitingDeadline
            | ResidentDiLifecycleState::AwaitingHost
            | ResidentDiLifecycleState::ReadReady => {
                self.healthy = false;
            }
        }
        self.evidence.current_state = ResidentDiLifecycleState::Idle;
        self.evidence.current_kind = None;
    }

    fn snapshot(&self) -> Option<ResidentDiLifecycleEvidence> {
        self.healthy.then_some(self.evidence)
    }
}

/// DTK buffer defaults authenticated from the committed GameCube disc header.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ResidentAudioBufferConfiguration {
    pub enabled: bool,
    pub buffer_length: u8,
}

#[derive(Debug)]
struct ResidentRead {
    bytes: Vec<u8>,
    filled: u32,
    current_request: Option<DiscReadRequest>,
    failed: bool,
}

impl ResidentRead {
    fn ready(&self) -> bool {
        self.failed || self.filled as usize == self.bytes.len()
    }
}

#[derive(Debug, Clone, Copy)]
struct Transaction {
    kind: ResidentCommandKind,
    opcode: u8,
    command0: u32,
    command1: u32,
    command2: u32,
    disc_offset: Option<u64>,
    dma_address: u32,
    dma_length: u32,
    requested_length: u32,
    transfer_length: u32,
    control: u32,
    trigger_cycle: u64,
    completion_cycle: u64,
    reservation_invalidated_at_start: bool,
}

#[derive(Debug)]
struct PendingCommand {
    transaction: Transaction,
    interrupt_status: u32,
    error_code: u32,
    read: Option<ResidentRead>,
}

impl PendingCommand {
    fn ready(&self) -> bool {
        self.read.as_ref().is_none_or(ResidentRead::ready)
    }
}

#[derive(Debug)]
struct ResidentAudioState {
    enabled: bool,
    buffer_length: u8,
    streaming: bool,
    stop_at_track_end: bool,
    start: u64,
    length: u64,
    position: u64,
    next_start: u64,
    next_length: u64,
    next_cycle: Option<u64>,
    ai_playing: bool,
    ai_sample_rate: ai::SampleRate,
}

impl Default for ResidentAudioState {
    fn default() -> Self {
        Self {
            enabled: false,
            buffer_length: 0,
            streaming: false,
            stop_at_track_end: false,
            start: 0,
            length: 0,
            position: 0,
            next_start: 0,
            next_length: 0,
            next_cycle: None,
            ai_playing: false,
            // AISFR's reset value is zero, whose effective auxiliary rate is 32,029 Hz.
            ai_sample_rate: ai::SampleRate::KHz32,
        }
    }
}

#[derive(Debug)]
struct ResidentState {
    epoch: u64,
    next_request_id: u64,
    disc_logical_bytes: Option<u64>,
    pending: Option<PendingCommand>,
    last_error: u32,
    drive_state: u8,
    audio: ResidentAudioState,
    control_before_start: u32,
}

impl Default for ResidentState {
    fn default() -> Self {
        Self {
            epoch: 1,
            next_request_id: 1,
            disc_logical_bytes: None,
            pending: None,
            last_error: ERROR_NONE,
            drive_state: 0,
            audio: ResidentAudioState::default(),
            control_before_start: 0,
        }
    }
}

#[derive(Default)]
pub struct Interface {
    pub status: Status,
    pub control: Control,
    pub command_buffer: [u32; 3],
    pub dma_base: Address,
    pub dma_length: u32,
    pub cover: Cover,
    pub config: u32,
    pub immediate: u32,
    resident_reset_generation: ResidentResetGeneration,
    resident_reset_pending: bool,
    resident: ResidentState,
    resident_lifecycle: ResidentDiLifecycle,
}

impl Interface {
    pub fn write_status(&mut self, value: Status) {
        self.status.set_break_request(value.break_request());
        self.status
            .set_device_err_interrupt_mask(value.device_err_interrupt_mask());
        self.status.set_device_err_interrupt(
            self.status.device_err_interrupt() & !value.device_err_interrupt(),
        );
        self.status
            .set_transfer_interrupt_mask(value.transfer_interrupt_mask());
        self.status
            .set_transfer_interrupt(self.status.transfer_interrupt() & !value.transfer_interrupt());
        self.status
            .set_break_interrupt_mask(value.break_interrupt_mask());
        self.status
            .set_break_interrupt(self.status.break_interrupt() & !value.break_interrupt());
    }

    pub fn write_cover(&mut self, value: Cover) {
        self.cover.set_interrupt_mask(value.interrupt_mask());
        self.cover
            .set_interrupt(self.cover.interrupt() & !value.interrupt());
    }

    pub fn command(&self) -> Result<Command, CommandDecodeError> {
        let bytes = self.command_buffer[0].to_be_bytes();
        let opcode = Opcode::new(bytes[0]).ok_or(CommandDecodeError::UnknownOpcode(bytes[0]))?;
        match opcode {
            Opcode::Identify => Ok(Command::Identify),
            Opcode::Read => {
                if bytes[3] == 0x40
                    && (self.command_buffer[1] != 0
                        || self.command_buffer[2] != 0x20
                        || self.dma_length != 0x20)
                {
                    return Err(CommandDecodeError::InvalidReadDiscId);
                }
                Ok(Command::Read {
                    offset: self.command_buffer[1] << 2,
                    length: self.command_buffer[2],
                })
            }
            Opcode::Seek => Ok(Command::Seek {
                offset: self.command_buffer[1] << 2,
            }),
            Opcode::Status => Ok(Command::Status),
            Opcode::AudioStream => match bytes[1] {
                0x00 => Ok(Command::StartAudioStream {
                    offset: self.command_buffer[1] << 2,
                    length: self.command_buffer[2],
                }),
                0x01 => Ok(Command::StopAudioStream),
                subcommand => Err(CommandDecodeError::InvalidAudioStream(subcommand)),
            },
            Opcode::AudioStatus => match bytes[1] {
                0x00 => Ok(Command::AudioStreamStatus),
                subcommand => Err(CommandDecodeError::InvalidAudioStatus(subcommand)),
            },
            Opcode::StopMotor => Ok(Command::StopMotor),
            Opcode::AudioConfig => match (bytes[1], bytes[3]) {
                (0x00, 0x00) => Ok(Command::DisableAudioStream),
                (0x01, 0x0A) => Ok(Command::EnableAudioStream),
                (subcommand, field) => {
                    Err(CommandDecodeError::InvalidAudioConfig { subcommand, field })
                }
            },
            Opcode::Debug => Ok(Command::Debug),
            Opcode::DebugEnable => Ok(Command::DebugEnable),
        }
    }

    #[must_use]
    pub fn resident_interrupt_level(&self) -> bool {
        self.status.any_interrupt()
    }

    #[must_use]
    pub fn resident_deadlines(&self) -> ResidentDeadlines {
        ResidentDeadlines {
            completion: self
                .resident
                .pending
                .as_ref()
                .map(|pending| pending.transaction.completion_cycle),
            audio: self.resident.audio.next_cycle,
        }
    }

    pub fn publish_resident_deadlines(&self, deadlines: &mut MachineEventDeadlines) {
        let resident = self.resident_deadlines();
        deadlines.set(MachineEventKind::DiskCompletion, resident.completion);
        deadlines.set(MachineEventKind::DiskAudio, resident.audio);
    }

    /// Synchronizes DTK scheduling to the authoritative AI play/rate state at one guest cycle.
    ///
    /// The caller services DI through `observed_cycle` before invoking this edge. A play or rate
    /// change then reanchors the next complete DTK batch exactly like the browser baseline, while
    /// an unchanged state preserves the already-authored phase.
    pub fn synchronize_resident_ai_state(
        &mut self,
        playing: bool,
        sample_rate: ai::SampleRate,
        observed_cycle: u64,
    ) -> Result<(), ResidentAudioScheduleError> {
        let audio = &mut self.resident.audio;
        let force = audio.ai_playing != playing || audio.ai_sample_rate != sample_rate;
        audio.ai_playing = playing;
        audio.ai_sample_rate = sample_rate;

        if !audio.streaming || !playing {
            audio.next_cycle = None;
            return Ok(());
        }
        if force || audio.next_cycle.is_none() {
            audio.next_cycle = Some(
                observed_cycle
                    .checked_add(AUDIO_BATCH_CYCLES)
                    .ok_or(ResidentAudioScheduleError::CycleOverflow)?,
            );
        }
        Ok(())
    }

    /// Returns the diagnostic generation of the most recent resident DI reset.
    #[must_use]
    pub const fn resident_reset_generation(&self) -> ResidentResetGeneration {
        self.resident_reset_generation
    }

    /// Whether the browser DI adapter still needs to observe a resident DI reset.
    #[must_use]
    pub const fn resident_reset_pending(&self) -> bool {
        self.resident_reset_pending
    }

    /// Returns one address-free copy of the cumulative DI command lifecycle.
    #[must_use]
    pub fn resident_di_lifecycle_evidence(&self) -> Option<ResidentDiLifecycleEvidence> {
        self.resident_lifecycle.snapshot()
    }

    #[cfg(test)]
    pub(crate) fn set_resident_epoch_for_test(&mut self, epoch: u64) {
        self.resident.epoch = epoch;
    }

    /// Takes one coalesced reset notification for the browser DI adapter.
    pub fn take_resident_reset(&mut self) -> Option<ResidentResetGeneration> {
        if !std::mem::take(&mut self.resident_reset_pending) {
            return None;
        }
        Some(self.resident_reset_generation)
    }

    /// Selects a logical disc and advances the identity epoch. The current command must be idle.
    pub fn configure_resident_disc(
        &mut self,
        logical_bytes: Option<u64>,
    ) -> Result<u64, ResidentDiscConfigError> {
        if let Some(pending) = &self.resident.pending {
            return Err(ResidentDiscConfigError::Busy {
                completion_cycle: pending.transaction.completion_cycle,
            });
        }
        if self.control.transfer_ongoing() {
            return Err(ResidentDiscConfigError::StartPending);
        }
        let epoch = self
            .resident
            .epoch
            .checked_add(1)
            .ok_or(ResidentDiscConfigError::EpochExhausted)?;
        self.resident.epoch = epoch;
        self.resident.disc_logical_bytes = logical_bytes;
        Ok(epoch)
    }

    /// Atomically selects one committed disc and seeds its authenticated header DTK defaults.
    pub fn configure_resident_boot_disc(
        &mut self,
        logical_bytes: u64,
        audio: ResidentAudioBufferConfiguration,
    ) -> Result<u64, ResidentDiscConfigError> {
        let epoch = self.configure_resident_disc(Some(logical_bytes))?;
        let ai_playing = self.resident.audio.ai_playing;
        let ai_sample_rate = self.resident.audio.ai_sample_rate;
        self.resident.audio = ResidentAudioState {
            enabled: audio.enabled,
            buffer_length: audio.buffer_length,
            ai_playing,
            ai_sample_rate,
            ..ResidentAudioState::default()
        };
        Ok(epoch)
    }

    /// Returns the committed disc-header DTK defaults without exposing mutable device state.
    #[must_use]
    pub const fn resident_audio_buffer_configuration(&self) -> ResidentAudioBufferConfiguration {
        ResidentAudioBufferConfiguration {
            enabled: self.resident.audio.enabled,
            buffer_length: self.resident.audio.buffer_length,
        }
    }

    /// Cancels all resident DI work while making every old host completion stale.
    pub fn reset_resident(&mut self) -> Result<(), ResidentResetError> {
        let epoch = self
            .resident
            .epoch
            .checked_add(1)
            .ok_or(ResidentResetError::EpochExhausted)?;
        let next_request_id = self.resident.next_request_id;
        let disc_logical_bytes = self.resident.disc_logical_bytes;
        let ai_playing = self.resident.audio.ai_playing;
        let ai_sample_rate = self.resident.audio.ai_sample_rate;
        self.status = Status::default();
        self.control = Control::default();
        self.command_buffer = [0; 3];
        self.dma_base = Address(0);
        self.dma_length = 0;
        self.cover = Cover::default();
        self.config = 0;
        self.immediate = 0;
        self.resident = ResidentState {
            epoch,
            next_request_id,
            disc_logical_bytes,
            audio: ResidentAudioState {
                ai_playing,
                ai_sample_rate,
                ..ResidentAudioState::default()
            },
            ..ResidentState::default()
        };
        self.resident_lifecycle.cancel_current();
        self.resident_reset_generation.0 = self.resident_reset_generation.0.wrapping_add(1);
        self.resident_reset_pending = true;
        Ok(())
    }

    #[must_use]
    pub fn resident_payload_bytes(&self) -> usize {
        self.resident
            .pending
            .as_ref()
            .and_then(|pending| pending.read.as_ref())
            .map_or(0, |read| read.bytes.len())
    }

    #[must_use]
    pub fn resident_payload_capacity_bytes(&self) -> usize {
        self.resident
            .pending
            .as_ref()
            .and_then(|pending| pending.read.as_ref())
            .map_or(0, |read| read.bytes.capacity())
    }

    #[must_use]
    pub fn resident_read_request(&self) -> Option<DiscReadRequest> {
        self.resident
            .pending
            .as_ref()?
            .read
            .as_ref()?
            .current_request
    }

    pub fn write_resident_command_word(
        &mut self,
        index: u8,
        value: u32,
    ) -> Result<(), ResidentRegisterWriteError> {
        self.ensure_resident_idle()?;
        let Some(word) = self.command_buffer.get_mut(index as usize) else {
            return Err(ResidentRegisterWriteError::InvalidCommandWord(index));
        };
        *word = value;
        Ok(())
    }

    pub fn write_resident_dma_address(
        &mut self,
        value: u32,
    ) -> Result<(), ResidentRegisterWriteError> {
        self.ensure_resident_idle()?;
        self.dma_base = Address(value & DMA_ADDRESS_MASK);
        Ok(())
    }

    pub fn write_resident_dma_length(
        &mut self,
        value: u32,
    ) -> Result<(), ResidentRegisterWriteError> {
        self.ensure_resident_idle()?;
        self.dma_length = value & DMA_LENGTH_MASK;
        Ok(())
    }

    pub fn write_resident_immediate(
        &mut self,
        value: u32,
    ) -> Result<(), ResidentRegisterWriteError> {
        self.ensure_resident_idle()?;
        self.immediate = value;
        Ok(())
    }

    fn ensure_resident_idle(&self) -> Result<(), ResidentRegisterWriteError> {
        if let Some(pending) = &self.resident.pending {
            Err(ResidentRegisterWriteError::Busy {
                completion_cycle: pending.transaction.completion_cycle,
            })
        } else if self.control.transfer_ongoing() {
            Err(ResidentRegisterWriteError::StartPending)
        } else {
            Ok(())
        }
    }

    /// Applies the exact control mask without beginning the command.
    ///
    /// This preserves the browser's MMIO/service separation: once TSTART is stored, all command,
    /// DMA, and control rewrites are BUSY until [`Self::begin_programmed_resident_command`] either
    /// accepts the immutable transaction or rejects it and restores the pre-start control word.
    pub fn program_resident_control(
        &mut self,
        value: u32,
    ) -> Result<u32, ResidentRegisterWriteError> {
        self.ensure_resident_idle()?;
        let control = value & DMA_CONTROL_MASK;
        if control & 1 != 0 {
            self.resident.control_before_start = control_bits(self.control);
        }
        self.control = Control::from_bits(control);
        if control & 1 != 0 {
            self.resident_lifecycle
                .begin_start(resident_command_kind(self.command_buffer[0]));
        }
        Ok(control)
    }

    /// Begins a previously programmed TSTART at the exact Rust-observed device-service cycle.
    pub fn begin_programmed_resident_command(
        &mut self,
        observed_cycle: u64,
        mem1: &mut [u8],
        reservation: &mut LoadStoreReservation,
    ) -> Result<Option<ResidentCommandStart>, ResidentStartError> {
        if let Some(pending) = &self.resident.pending {
            return Err(ResidentStartError::Busy {
                completion_cycle: pending.transaction.completion_cycle,
            });
        }
        let control = control_bits(self.control);
        if control & 1 == 0 {
            self.resident_lifecycle.clear_unaccepted_start();
            return Ok(None);
        }
        match self.begin_programmed_resident_command_inner(
            control,
            observed_cycle,
            mem1,
            reservation,
        ) {
            Ok(start) => {
                self.resident_lifecycle.accept_start(start);
                Ok(Some(start))
            }
            Err(error) => {
                self.control = Control::from_bits(self.resident.control_before_start & !1);
                self.resident_lifecycle
                    .reject_start(resident_command_kind(self.command_buffer[0]), true);
                Err(error)
            }
        }
    }

    /// Convenience path that programs DI control and immediately reaches its service boundary.
    ///
    /// A rejected start preserves the previously programmed control word and all command/DMA
    /// registers. The passed MEM1 and reservation are touched at start only for Inquiry's proven
    /// immediate twelve-byte response.
    pub fn write_resident_control(
        &mut self,
        value: u32,
        observed_cycle: u64,
        mem1: &mut [u8],
        reservation: &mut LoadStoreReservation,
    ) -> Result<Option<ResidentCommandStart>, ResidentStartError> {
        match self.program_resident_control(value) {
            Ok(_) => {}
            Err(ResidentRegisterWriteError::Busy { completion_cycle }) => {
                if value & 1 != 0 {
                    self.resident_lifecycle
                        .reject_start(resident_command_kind(self.command_buffer[0]), false);
                }
                return Err(ResidentStartError::Busy { completion_cycle });
            }
            Err(ResidentRegisterWriteError::StartPending) => {
                if value & 1 != 0 {
                    self.resident_lifecycle
                        .reject_start(resident_command_kind(self.command_buffer[0]), false);
                }
                return Err(ResidentStartError::StartPending);
            }
            Err(ResidentRegisterWriteError::InvalidCommandWord(_)) => {
                return Err(ResidentStartError::StartPending);
            }
        }
        self.begin_programmed_resident_command(observed_cycle, mem1, reservation)
    }

    fn begin_programmed_resident_command_inner(
        &mut self,
        control: u32,
        observed_cycle: u64,
        mem1: &mut [u8],
        reservation: &mut LoadStoreReservation,
    ) -> Result<ResidentCommandStart, ResidentStartError> {
        let command0 = self.command_buffer[0];
        let command1 = self.command_buffer[1];
        let command2 = self.command_buffer[2];
        let opcode = (command0 >> 24) as u8;
        let dma_command = matches!(opcode, 0x12 | 0xa8);
        if dma_command && (control & 2 == 0 || control & 4 != 0) {
            return Err(ResidentStartError::InvalidControlMode { control });
        }
        if !dma_command && control & 2 != 0 {
            return Err(ResidentStartError::UnsupportedDmaCommand { command0 });
        }

        let dma_address = self.dma_base.value() & DMA_ADDRESS_MASK;
        let dma_length = self.dma_length & DMA_LENGTH_MASK;
        let common = |kind, completion_cycle| Transaction {
            kind,
            opcode,
            command0,
            command1,
            command2,
            disc_offset: None,
            dma_address,
            dma_length,
            requested_length: 0,
            transfer_length: 0,
            control,
            trigger_cycle: observed_cycle,
            completion_cycle,
            reservation_invalidated_at_start: false,
        };

        let pending = match opcode {
            0x12 => {
                if dma_length != 0x20 {
                    return Err(ResidentStartError::InvalidInquiryLength(dma_length));
                }
                validate_mem1_range(mem1.len(), dma_address, dma_length)?;
                let completion_cycle = observed_cycle
                    .checked_add(MINIMUM_COMMAND_LATENCY_CYCLES)
                    .ok_or(ResidentStartError::CycleOverflow)?;
                let target = dma_address as usize;
                mem1[target..target + INQUIRY_COMPATIBILITY_BYTES.len()]
                    .copy_from_slice(&INQUIRY_COMPATIBILITY_BYTES);
                let invalidated = reservation
                    .invalidate_range(Address(dma_address), INQUIRY_COMPATIBILITY_BYTES.len());
                let mut transaction = common(ResidentCommandKind::Inquiry, completion_cycle);
                transaction.transfer_length = dma_length;
                transaction.reservation_invalidated_at_start = invalidated;
                PendingCommand {
                    transaction,
                    interrupt_status: 0x10,
                    error_code: ERROR_NONE,
                    read: None,
                }
            }
            0xa8 => {
                let subcommand = command0 as u8;
                if !matches!(subcommand, 0x00 | 0x40) {
                    return Err(ResidentStartError::InvalidReadSubcommand(subcommand));
                }
                let kind = if subcommand == 0x40 {
                    ResidentCommandKind::ReadDiscId
                } else {
                    ResidentCommandKind::ReadSector
                };
                let disc_offset = if subcommand == 0x40 {
                    0
                } else {
                    u64::from(command1) * 4
                };
                let requested_length = if subcommand == 0x40 { 0x20 } else { command2 };
                if requested_length == 0 {
                    return Err(ResidentStartError::ZeroRequestedLength);
                }
                if dma_length == 0 {
                    return Err(ResidentStartError::ZeroDmaLength);
                }
                let transfer_length = requested_length.min(dma_length);
                validate_mem1_range(mem1.len(), dma_address, transfer_length)?;
                let disc_bytes = self
                    .resident
                    .disc_logical_bytes
                    .ok_or(ResidentStartError::DiscRangeUnknown)?;
                let disc_end = disc_offset
                    .checked_add(u64::from(transfer_length))
                    .ok_or(ResidentStartError::DiscRangeOverflow)?;

                if disc_end > disc_bytes {
                    let completion_cycle = observed_cycle
                        .checked_add(MINIMUM_COMMAND_LATENCY_CYCLES)
                        .ok_or(ResidentStartError::CycleOverflow)?;
                    let mut transaction = common(kind, completion_cycle);
                    transaction.disc_offset = Some(disc_offset);
                    transaction.requested_length = requested_length;
                    transaction.transfer_length = transfer_length;
                    PendingCommand {
                        transaction,
                        interrupt_status: 0x04,
                        error_code: ERROR_BLOCK_OUT_OF_BOUNDS,
                        read: None,
                    }
                } else {
                    let delay = buffered_read_lower_bound_cycles(transfer_length, disc_offset)
                        .ok_or(ResidentStartError::CycleOverflow)?;
                    let completion_cycle = observed_cycle
                        .checked_add(delay)
                        .ok_or(ResidentStartError::CycleOverflow)?;
                    let chunk_count = transfer_length.div_ceil(MAX_DISC_READ_CHUNK_BYTES);
                    let request_id_end = self
                        .resident
                        .next_request_id
                        .checked_add(u64::from(chunk_count))
                        .ok_or(ResidentStartError::RequestIdExhausted)?;
                    let mut bytes = Vec::new();
                    bytes
                        .try_reserve_exact(transfer_length as usize)
                        .map_err(|_| ResidentStartError::PayloadAllocationFailed {
                            length: transfer_length,
                        })?;
                    bytes.resize(transfer_length as usize, 0);
                    let request = DiscReadRequest {
                        epoch: self.resident.epoch,
                        id: self.resident.next_request_id,
                        disc_offset,
                        length: transfer_length.min(MAX_DISC_READ_CHUNK_BYTES),
                    };
                    self.resident.next_request_id = request_id_end;
                    let mut transaction = common(kind, completion_cycle);
                    transaction.disc_offset = Some(disc_offset);
                    transaction.requested_length = requested_length;
                    transaction.transfer_length = transfer_length;
                    PendingCommand {
                        transaction,
                        interrupt_status: 0x10,
                        error_code: ERROR_NONE,
                        read: Some(ResidentRead {
                            bytes,
                            filled: 0,
                            current_request: Some(request),
                            failed: false,
                        }),
                    }
                }
            }
            _ => self.begin_resident_non_read(common)?,
        };

        let start = ResidentCommandStart {
            kind: pending.transaction.kind,
            completion_cycle: pending.transaction.completion_cycle,
            read_request: pending.read.as_ref().and_then(|read| read.current_request),
        };
        self.resident.last_error = pending.error_code;
        self.resident.pending = Some(pending);
        Ok(start)
    }

    fn begin_resident_non_read(
        &mut self,
        common: impl FnOnce(ResidentCommandKind, u64) -> Transaction,
    ) -> Result<PendingCommand, ResidentStartError> {
        let mut transaction = common(ResidentCommandKind::Unsupported, 0);
        transaction.completion_cycle = transaction
            .trigger_cycle
            .checked_add(MINIMUM_COMMAND_LATENCY_CYCLES)
            .ok_or(ResidentStartError::CycleOverflow)?;

        let opcode = transaction.opcode;
        let audio_subcommand = (transaction.command0 >> 16) as u8;
        let mut interrupt_status = 0x10;
        let mut error_code = ERROR_NONE;
        transaction.kind = match opcode {
            0xab => {
                transaction.disc_offset = Some(u64::from(transaction.command1) * 4);
                ResidentCommandKind::Seek
            }
            0xe0 => {
                self.immediate = (u32::from(self.resident.drive_state) << 24)
                    | (self.resident.last_error & 0x00ff_ffff);
                self.resident.last_error = ERROR_NONE;
                ResidentCommandKind::RequestError
            }
            0xe1 => {
                if !self.resident.audio.enabled {
                    interrupt_status = 0x04;
                    error_code = ERROR_NO_AUDIO_BUFFER;
                } else if audio_subcommand == 0 {
                    let offset = u64::from(transaction.command1) * 4;
                    let length = u64::from(transaction.command2);
                    let was_streaming = self.resident.audio.streaming;
                    if offset == 0 && length == 0 {
                        self.resident.audio.stop_at_track_end = true;
                    } else if !self.resident.audio.stop_at_track_end {
                        self.resident.audio.next_start = offset;
                        self.resident.audio.next_length = length;
                        if !self.resident.audio.streaming {
                            self.resident.audio.start = offset;
                            self.resident.audio.length = length;
                            self.resident.audio.position = offset;
                            self.resident.audio.streaming = true;
                        }
                    }
                    if !was_streaming
                        && self.resident.audio.streaming
                        && self.resident.audio.ai_playing
                    {
                        self.resident.audio.next_cycle = Some(
                            transaction
                                .trigger_cycle
                                .checked_add(AUDIO_BATCH_CYCLES)
                                .ok_or(ResidentStartError::CycleOverflow)?,
                        );
                    }
                } else if audio_subcommand == 1 {
                    self.resident.audio.stop_at_track_end = false;
                    self.resident.audio.streaming = false;
                    self.resident.audio.next_cycle = None;
                } else {
                    interrupt_status = 0x04;
                    error_code = ERROR_INVALID_AUDIO_COMMAND;
                }
                ResidentCommandKind::AudioStream
            }
            0xe2 => {
                if !self.resident.audio.enabled {
                    interrupt_status = 0x04;
                    error_code = ERROR_NO_AUDIO_BUFFER;
                } else {
                    self.immediate = match audio_subcommand {
                        0 => u32::from(self.resident.audio.streaming),
                        1 => ((self.resident.audio.position & 0xffff_8000) >> 2) as u32,
                        2 => (self.resident.audio.start / 4) as u32,
                        3 => self.resident.audio.length as u32,
                        _ => {
                            interrupt_status = 0x04;
                            error_code = ERROR_INVALID_AUDIO_COMMAND;
                            0
                        }
                    };
                }
                ResidentCommandKind::AudioStatus
            }
            0xe3 => {
                self.resident.audio.stop_at_track_end = false;
                self.resident.audio.streaming = false;
                self.resident.audio.next_cycle = None;
                self.resident.drive_state = 4;
                self.immediate = 0;
                ResidentCommandKind::StopMotor
            }
            0xe4 => {
                self.resident.audio.enabled = (transaction.command0 >> 16) & 1 != 0;
                self.resident.audio.buffer_length = transaction.command0 as u8 & 0x0f;
                if !self.resident.audio.enabled {
                    self.resident.audio.stop_at_track_end = false;
                    self.resident.audio.streaming = false;
                    self.resident.audio.next_cycle = None;
                }
                ResidentCommandKind::AudioConfig
            }
            _ => {
                interrupt_status = 0x04;
                error_code = ERROR_INVALID_COMMAND;
                ResidentCommandKind::Unsupported
            }
        };
        Ok(PendingCommand {
            transaction,
            interrupt_status,
            error_code,
            read: None,
        })
    }

    fn validate_read_request(
        &self,
        request: DiscReadRequest,
    ) -> Result<DiscReadRequest, DiscReadCompletionError> {
        let Some(pending) = self.resident.pending.as_ref() else {
            return Err(if request.id < self.resident.next_request_id {
                DiscReadCompletionError::StaleRequest { id: request.id }
            } else {
                DiscReadCompletionError::UnknownRequest { id: request.id }
            });
        };
        let Some(read) = pending.read.as_ref() else {
            return Err(DiscReadCompletionError::NoPendingRead);
        };
        let Some(expected) = read.current_request else {
            return Err(DiscReadCompletionError::ResultAlreadyProvided { request });
        };
        if request.id < expected.id {
            return Err(DiscReadCompletionError::StaleRequest { id: request.id });
        }
        if request.id > expected.id {
            return Err(DiscReadCompletionError::OutOfOrderRequest {
                expected,
                received: request,
            });
        }
        if request != expected {
            return Err(DiscReadCompletionError::DescriptorMismatch {
                expected,
                received: request,
            });
        }
        Ok(expected)
    }

    /// Borrows only the current Rust-private request window. No host-owned payload is accepted.
    pub fn resident_read_staging_mut(
        &mut self,
        request: DiscReadRequest,
    ) -> Result<&mut [u8], DiscReadCompletionError> {
        let expected = self.validate_read_request(request)?;
        let pending = self
            .resident
            .pending
            .as_mut()
            .ok_or(DiscReadCompletionError::NoPendingRead)?;
        let read = pending
            .read
            .as_mut()
            .ok_or(DiscReadCompletionError::NoPendingRead)?;
        let start = read.filled as usize;
        let end = start + expected.length as usize;
        Ok(&mut read.bytes[start..end])
    }

    /// Consumes one exact host completion. Short and overlong results terminate the read as a
    /// bounded device error; identity failures leave the live request untouched.
    pub fn complete_resident_disc_read(
        &mut self,
        request: DiscReadRequest,
        written: u32,
    ) -> Result<(), DiscReadCompletionError> {
        let expected = self.validate_read_request(request)?;
        let pending = self
            .resident
            .pending
            .as_mut()
            .ok_or(DiscReadCompletionError::NoPendingRead)?;
        let read = pending
            .read
            .as_mut()
            .ok_or(DiscReadCompletionError::NoPendingRead)?;
        if written != expected.length {
            read.current_request = None;
            read.failed = true;
            pending.interrupt_status = 0x04;
            pending.error_code = ERROR_READ;
            self.resident_lifecycle.read_ready();
            return Err(if written < expected.length {
                DiscReadCompletionError::ShortRead { request, written }
            } else {
                DiscReadCompletionError::OverlongRead { request, written }
            });
        }

        read.filled += written;
        if read.filled as usize == read.bytes.len() {
            read.current_request = None;
            self.resident_lifecycle.read_ready();
            return Ok(());
        }
        let remaining = read.bytes.len() as u32 - read.filled;
        read.current_request = Some(DiscReadRequest {
            epoch: expected.epoch,
            id: expected.id + 1,
            disc_offset: expected.disc_offset + u64::from(expected.length),
            length: remaining.min(MAX_DISC_READ_CHUNK_BYTES),
        });
        self.resident_lifecycle.read_window_pending();
        Ok(())
    }

    /// Records a host/file failure for the exact current read request.
    pub fn fail_resident_disc_read(
        &mut self,
        request: DiscReadRequest,
    ) -> Result<(), DiscReadCompletionError> {
        self.validate_read_request(request)?;
        let pending = self
            .resident
            .pending
            .as_mut()
            .ok_or(DiscReadCompletionError::NoPendingRead)?;
        let read = pending
            .read
            .as_mut()
            .ok_or(DiscReadCompletionError::NoPendingRead)?;
        read.current_request = None;
        read.failed = true;
        pending.interrupt_status = 0x04;
        pending.error_code = ERROR_READ;
        self.resident_lifecycle.read_ready();
        Ok(())
    }

    /// Services DTK first and command completion second, matching the browser's disk phase.
    pub fn service_resident(
        &mut self,
        observed_cycle: u64,
        mem1: &mut [u8],
        reservation: &mut LoadStoreReservation,
    ) -> ResidentServiceSummary {
        let audio = self.service_resident_audio(observed_cycle);
        let command = self.service_resident_completion(observed_cycle, mem1, reservation);
        ResidentServiceSummary {
            audio,
            command,
            interrupt_level: self.resident_interrupt_level(),
        }
    }

    fn service_resident_audio(&mut self, observed_cycle: u64) -> ResidentAudioService {
        let mut summary = ResidentAudioService::default();
        while self
            .resident
            .audio
            .next_cycle
            .is_some_and(|cycle| cycle <= observed_cycle)
        {
            let scheduled_cycle = self.resident.audio.next_cycle.unwrap_or(observed_cycle);
            if !self.resident.audio.streaming || !self.resident.audio.ai_playing {
                self.resident.audio.next_cycle = None;
                break;
            }
            let blocks_per_batch = match self.resident.audio.ai_sample_rate {
                ai::SampleRate::KHz48 => 6,
                ai::SampleRate::KHz32 => 4,
            };
            for _ in 0..blocks_per_batch {
                if !self.resident.audio.streaming {
                    break;
                }
                let end = self
                    .resident
                    .audio
                    .start
                    .saturating_add(self.resident.audio.length);
                if self.resident.audio.position >= end {
                    self.resident.audio.position = self.resident.audio.next_start;
                    self.resident.audio.start = self.resident.audio.next_start;
                    self.resident.audio.length = self.resident.audio.next_length;
                    if self.resident.audio.stop_at_track_end {
                        self.resident.audio.stop_at_track_end = false;
                        self.resident.audio.streaming = false;
                        break;
                    }
                }
                self.resident.audio.position = self.resident.audio.position.saturating_add(32);
                summary.blocks += 1;
            }
            summary.batches += 1;
            self.resident.audio.next_cycle = if self.resident.audio.streaming {
                scheduled_cycle.checked_add(AUDIO_BATCH_CYCLES)
            } else {
                None
            };
        }
        summary
    }

    fn service_resident_completion(
        &mut self,
        observed_cycle: u64,
        mem1: &mut [u8],
        reservation: &mut LoadStoreReservation,
    ) -> ResidentServiceState {
        let Some(mut pending) = self.resident.pending.take() else {
            return ResidentServiceState::Idle;
        };
        let completion_cycle = pending.transaction.completion_cycle;
        if observed_cycle < completion_cycle {
            self.resident.pending = Some(pending);
            return ResidentServiceState::BeforeDeadline { completion_cycle };
        }
        if !pending.ready() {
            if let Some(request) = pending.read.as_ref().and_then(|read| read.current_request) {
                self.resident.pending = Some(pending);
                return ResidentServiceState::WaitingForHost {
                    completion_cycle,
                    request,
                };
            }
            // Corrupt or partially integrated adapter state is a bounded read error, never a
            // guest-triggerable trap. The normal typed protocol cannot reach this branch.
            pending.interrupt_status = 0x04;
            pending.error_code = ERROR_READ;
        }

        let mut memory_write_bytes = 0;
        let mut reservation_invalidated = pending.transaction.reservation_invalidated_at_start;
        if matches!(
            pending.transaction.kind,
            ResidentCommandKind::ReadSector | ResidentCommandKind::ReadDiscId
        ) && pending.interrupt_status == 0x10
        {
            let valid_payload = pending.read.as_ref().is_some_and(|read| {
                !read.failed
                    && read.filled == pending.transaction.transfer_length
                    && read.bytes.len() == pending.transaction.transfer_length as usize
            });
            let start = pending.transaction.dma_address as usize;
            let end = start.checked_add(pending.transaction.transfer_length as usize);
            let valid_target = end.is_some_and(|end| end <= mem1.len());
            if !valid_payload || !valid_target {
                pending.interrupt_status = 0x04;
                pending.error_code = ERROR_READ;
            } else if let (Some(read), Some(end)) = (pending.read.as_ref(), end) {
                mem1[start..end].copy_from_slice(&read.bytes);
                memory_write_bytes = pending.transaction.transfer_length;
                reservation_invalidated = reservation.invalidate_range(
                    Address(pending.transaction.dma_address),
                    pending.transaction.transfer_length as usize,
                );
            }
        }

        let successful = pending.interrupt_status == 0x10;
        if successful {
            self.dma_base = Address(
                pending
                    .transaction
                    .dma_address
                    .wrapping_add(pending.transaction.dma_length),
            );
            self.dma_length = 0;
        }
        self.control = Control::from_bits(pending.transaction.control & !1);
        if successful {
            self.status.set_transfer_interrupt(true);
        } else {
            self.status.set_device_err_interrupt(true);
        }
        self.resident.last_error = pending.error_code;
        let completion = ResidentCompletion {
            kind: pending.transaction.kind,
            completion_cycle,
            serviced_at_cycle: observed_cycle,
            successful,
            interrupt_status: pending.interrupt_status,
            error_code: pending.error_code,
            memory_write_bytes,
            reservation_invalidated,
        };
        self.resident_lifecycle.accept_completion(completion);
        ResidentServiceState::Completed(completion)
    }
}

#[inline(always)]
fn resident_command_kind(command0: u32) -> ResidentCommandKind {
    match (command0 >> 24) as u8 {
        0x12 => ResidentCommandKind::Inquiry,
        0xa8 if command0 as u8 == 0x40 => ResidentCommandKind::ReadDiscId,
        0xa8 => ResidentCommandKind::ReadSector,
        0xab => ResidentCommandKind::Seek,
        0xe0 => ResidentCommandKind::RequestError,
        0xe1 => ResidentCommandKind::AudioStream,
        0xe2 => ResidentCommandKind::AudioStatus,
        0xe3 => ResidentCommandKind::StopMotor,
        0xe4 => ResidentCommandKind::AudioConfig,
        _ => ResidentCommandKind::Unsupported,
    }
}

#[inline(always)]
fn control_bits(control: Control) -> u32 {
    u32::from(control.transfer_ongoing())
        | (u32::from(control.dma()) << 1)
        | (u32::from(control.mode() == TransferMode::Write) << 2)
}

fn validate_mem1_range(
    available: usize,
    dma_address: u32,
    length: u32,
) -> Result<(), ResidentStartError> {
    let start = dma_address as usize;
    let valid_prefix = if start >= available {
        0
    } else {
        length.min((available - start) as u32)
    };
    if valid_prefix != length {
        return Err(ResidentStartError::Mem1Range {
            dma_address,
            length,
            valid_prefix_bytes: valid_prefix,
        });
    }
    Ok(())
}

/// Exact integer lower bound used by the browser/Dolphin compatibility oracle.
#[must_use]
pub fn buffered_read_lower_bound_cycles(length: u32, disc_offset: u64) -> Option<u64> {
    let mut remaining = u64::from(length);
    let mut offset = disc_offset;
    let mut transfer_cycles = 0_u64;
    while remaining != 0 {
        let offset_in_block = offset % DVD_ECC_BLOCK_BYTES;
        let chunk_length = remaining.min(DVD_ECC_BLOCK_BYTES - offset_in_block);
        let cycles =
            chunk_length.checked_mul(CPU_CYCLES_PER_SECOND)? / BUFFER_TRANSFER_BYTES_PER_SECOND;
        transfer_cycles = transfer_cycles.checked_add(cycles)?;
        remaining -= chunk_length;
        offset = offset.checked_add(chunk_length)?;
    }
    READ_START_LATENCY_CYCLES.checked_add(transfer_cycles)
}

// --- Transitional native adapter -------------------------------------------------------------

pub fn complete_transfer(sys: &mut System) {
    tracing::debug!("completed DI transfer");
    sys.disk.status.set_transfer_interrupt(true);
    sys.disk.control.set_transfer_ongoing(false);
    sys.disk.dma_length = 0;
    pi::check_interrupts(sys);
}

pub fn complete_seek(sys: &mut System) {
    tracing::debug!("completed DI seek");
    sys.disk.status.set_transfer_interrupt(true);
    sys.disk.control.set_transfer_ongoing(false);
    pi::check_interrupts(sys);
}

fn fail_native_command(sys: &mut System) {
    sys.disk.status.set_device_err_interrupt(true);
    sys.disk.control.set_transfer_ongoing(false);
    pi::check_interrupts(sys);
}

/// Legacy synchronous/native disk adapter. Browser resident execution must use the typed methods
/// on [`Interface`] instead; this adapter remains only for the existing native runner.
pub fn write_control(sys: &mut System, value: Control) {
    sys.disk.control.set_dma(value.dma());
    sys.disk.control.set_mode(value.mode());
    if !value.transfer_ongoing() || sys.disk.control.transfer_ongoing() {
        return;
    }

    tracing::debug!("starting DI transfer through transitional native adapter");
    sys.disk.control.set_transfer_ongoing(true);
    let Ok(command) = sys.disk.command() else {
        fail_native_command(sys);
        return;
    };
    match command {
        Command::Identify => {
            let Some(target) = sys.mem.translate_data_addr(sys.disk.dma_base) else {
                fail_native_command(sys);
                return;
            };
            let start = target.value() as usize;
            let Some(end) = start.checked_add(sys.disk.dma_length as usize) else {
                fail_native_command(sys);
                return;
            };
            let Some(destination) = sys.mem.ram_mut().get_mut(start..end) else {
                fail_native_command(sys);
                return;
            };
            if destination.len() != 32 {
                fail_native_command(sys);
                return;
            }
            destination[..INQUIRY_COMPATIBILITY_BYTES.len()]
                .copy_from_slice(&INQUIRY_COMPATIBILITY_BYTES);
            sys.cpu
                .reservation
                .invalidate_range(target, INQUIRY_COMPATIBILITY_BYTES.len());
            sys.scheduler.schedule(10_000, complete_transfer);
        }
        Command::Read { offset, length } => {
            if !sys.disk.control.dma()
                || sys.disk.control.mode() != TransferMode::Read
                || length == 0
            {
                fail_native_command(sys);
                return;
            }
            let length = length.min(sys.disk.dma_length);
            let target = sys.disk.dma_base.value().with_bits(26, 32, 0);
            let start = target as usize;
            let Some(end) = start.checked_add(length as usize) else {
                fail_native_command(sys);
                return;
            };
            let Some(slice) = sys.mem.ram_mut().get_mut(start..end) else {
                fail_native_command(sys);
                return;
            };
            if !sys.modules.disk.has_disk()
                || sys
                    .modules
                    .disk
                    .seek(SeekFrom::Start(u64::from(offset)))
                    .is_err()
                || sys.modules.disk.read_exact(slice).is_err()
            {
                fail_native_command(sys);
                return;
            }
            sys.cpu
                .reservation
                .invalidate_range(Address(target), length as usize);
            sys.scheduler.schedule(10_000, complete_transfer);
        }
        Command::Seek { .. } => sys.scheduler.schedule(5_000, complete_seek),
        Command::StopMotor
        | Command::StartAudioStream { .. }
        | Command::StopAudioStream
        | Command::AudioStreamStatus
        | Command::EnableAudioStream
        | Command::DisableAudioStream
        | Command::Status
        | Command::Debug
        | Command::DebugEnable => {
            sys.disk.status.set_transfer_interrupt(true);
            sys.disk.control.set_transfer_ongoing(false);
            sys.disk.immediate = 0;
            pi::check_interrupts(sys);
        }
    }
}

pub fn reset(sys: &mut System, value: u32) -> Result<(), ResidentResetError> {
    if !value.bit(2) {
        return Ok(());
    }
    tracing::warn!("dvd drive reset through processor interface");
    sys.disk.reset_resident()?;
    pi::check_interrupts(sys);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::audio::NopAudioModule;
    use crate::modules::debug::NopDebugModule;
    use crate::modules::disk::NopDiskModule;
    use crate::modules::input::NopInputModule;
    use crate::modules::render::NopRenderModule;
    use crate::modules::vertex::NopVertexModule;
    use crate::system::{Config, Modules};

    fn ram(bytes: usize) -> Vec<u8> {
        vec![0xcc; bytes]
    }

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

    fn configure(interface: &mut Interface, disc_bytes: u64) {
        interface.configure_resident_disc(Some(disc_bytes)).unwrap();
    }

    fn program_read(
        interface: &mut Interface,
        mem1: &mut [u8],
        reservation: &mut LoadStoreReservation,
        cycle: u64,
        requested: u32,
        dma_length: u32,
    ) -> ResidentCommandStart {
        interface
            .write_resident_command_word(0, 0xa800_0000)
            .unwrap();
        interface.write_resident_command_word(1, 0x100).unwrap();
        interface.write_resident_command_word(2, requested).unwrap();
        interface.write_resident_dma_address(0x200).unwrap();
        interface.write_resident_dma_length(dma_length).unwrap();
        interface
            .write_resident_control(3, cycle, mem1, reservation)
            .unwrap()
            .unwrap()
    }

    fn fill_all_requests(interface: &mut Interface, seed: u8) {
        while let Some(request) = interface.resident_read_request() {
            let staging = interface.resident_read_staging_mut(request).unwrap();
            for (index, byte) in staging.iter_mut().enumerate() {
                *byte = seed.wrapping_add(index as u8);
            }
            interface
                .complete_resident_disc_read(request, request.length)
                .unwrap();
        }
    }

    #[test]
    fn masks_status_w1c_break_and_level_interrupts_match_oracle() {
        let mut interface = Interface::default();
        interface.write_resident_dma_address(u32::MAX).unwrap();
        interface.write_resident_dma_length(u32::MAX).unwrap();
        assert_eq!(interface.program_resident_control(u32::MAX), Ok(7));
        assert_eq!(interface.dma_base.value(), DMA_ADDRESS_MASK);
        assert_eq!(interface.dma_length, DMA_LENGTH_MASK);
        assert!(interface.control.transfer_ongoing());
        assert!(interface.control.dma());
        assert_eq!(interface.control.mode(), TransferMode::Write);
        assert_eq!(
            interface.write_resident_dma_address(0),
            Err(ResidentRegisterWriteError::StartPending)
        );

        interface.status.set_device_err_interrupt(true);
        interface.status.set_transfer_interrupt(true);
        interface.write_status(Status::from_bits(0x04 | 0x08 | 0x01));
        assert_eq!(interface.status.raw(), 0x10 | 0x08 | 0x01);
        assert!(interface.resident_interrupt_level());
        interface.write_status(Status::from_bits(0x10 | 0x08));
        assert_eq!(interface.status.raw(), 0x08);
        assert!(!interface.resident_interrupt_level());
    }

    #[test]
    fn read_is_clamped_and_commits_atomically_only_when_ready_and_due() {
        let mut interface = Interface::default();
        configure(&mut interface, 0x20_0000);
        let mut mem1 = ram(0x1000);
        let mut reservation = LoadStoreReservation::default();
        reservation.reserve(Address(0x200));
        let start = program_read(
            &mut interface,
            &mut mem1,
            &mut reservation,
            1_000,
            0x40,
            0x20,
        );
        assert_eq!(start.kind, ResidentCommandKind::ReadSector);
        assert_eq!(start.completion_cycle, 293_063);
        let request = start.read_request.unwrap();
        assert_eq!(request.disc_offset, 0x400);
        assert_eq!(request.length, 0x20);
        assert_eq!(&mem1[0x200..0x240], &[0xcc; 0x40]);
        assert_eq!(
            interface
                .service_resident(start.completion_cycle, &mut mem1, &mut reservation)
                .command,
            ResidentServiceState::WaitingForHost {
                completion_cycle: start.completion_cycle,
                request,
            }
        );
        assert_eq!(&mem1[0x200..0x240], &[0xcc; 0x40]);
        fill_all_requests(&mut interface, 0x42);
        assert!(matches!(
            interface
                .service_resident(start.completion_cycle - 1, &mut mem1, &mut reservation)
                .command,
            ResidentServiceState::BeforeDeadline { .. }
        ));
        let summary =
            interface.service_resident(start.completion_cycle, &mut mem1, &mut reservation);
        let ResidentServiceState::Completed(completion) = summary.command else {
            panic!("expected completion");
        };
        assert!(completion.successful);
        assert_eq!(completion.memory_write_bytes, 0x20);
        assert!(completion.reservation_invalidated);
        assert_eq!(interface.dma_base.value(), 0x220);
        assert_eq!(interface.dma_length, 0);
        assert!(!interface.control.transfer_ongoing());
        assert_eq!(&mem1[0x220..0x240], &[0xcc; 0x20]);
    }

    #[test]
    fn programmed_tstart_is_busy_until_exact_service_cycle_latches_transaction() {
        let mut interface = Interface::default();
        configure(&mut interface, 0x20_0000);
        let mut mem1 = ram(0x1000);
        let mut reservation = LoadStoreReservation::default();
        interface
            .write_resident_command_word(0, 0xa800_0000)
            .unwrap();
        interface.write_resident_command_word(1, 0x100).unwrap();
        interface.write_resident_command_word(2, 0x20).unwrap();
        interface.write_resident_dma_address(0x200).unwrap();
        interface.write_resident_dma_length(0x20).unwrap();
        assert_eq!(interface.program_resident_control(3), Ok(3));
        assert!(interface.resident_deadlines().completion.is_none());
        assert_eq!(
            interface.write_resident_command_word(1, 0x200),
            Err(ResidentRegisterWriteError::StartPending)
        );
        let start = interface
            .begin_programmed_resident_command(1_000, &mut mem1, &mut reservation)
            .unwrap()
            .unwrap();
        assert_eq!(start.completion_cycle, 293_063);
        assert_eq!(start.read_request.unwrap().disc_offset, 0x400);
        assert_eq!(
            interface.resident_deadlines().completion,
            Some(start.completion_cycle)
        );
    }

    #[test]
    fn inquiry_writes_only_twelve_bytes_immediately_then_delays_tc() {
        let mut interface = Interface::default();
        let mut mem1 = ram(0x1000);
        let mut reservation = LoadStoreReservation::default();
        reservation.reserve(Address(0x300));
        interface
            .write_resident_command_word(0, 0x1200_0000)
            .unwrap();
        interface.write_resident_dma_address(0x300).unwrap();
        interface.write_resident_dma_length(0x20).unwrap();
        let start = interface
            .write_resident_control(3, 3_000, &mut mem1, &mut reservation)
            .unwrap()
            .unwrap();
        assert_eq!(start.completion_cycle, 148_800);
        assert_eq!(&mem1[0x300..0x30c], &INQUIRY_COMPATIBILITY_BYTES);
        assert_eq!(&mem1[0x30c..0x320], &[0xcc; 20]);
        assert!(!reservation.is_valid());
        assert!(!interface.status.transfer_interrupt());
        interface.service_resident(start.completion_cycle, &mut mem1, &mut reservation);
        assert!(interface.status.transfer_interrupt());
        assert_eq!(interface.dma_base.value(), 0x320);
    }

    #[test]
    fn disc_id_uses_offset_zero_and_preserves_dma_suffix() {
        let mut interface = Interface::default();
        configure(&mut interface, 0x20_0000);
        let mut mem1 = ram(0x1000);
        let mut reservation = LoadStoreReservation::default();
        interface
            .write_resident_command_word(0, 0xa800_0040)
            .unwrap();
        interface.write_resident_command_word(1, u32::MAX).unwrap();
        interface.write_resident_command_word(2, u32::MAX).unwrap();
        interface.write_resident_dma_address(0x400).unwrap();
        interface.write_resident_dma_length(0x40).unwrap();
        let start = interface
            .write_resident_control(3, 4_000, &mut mem1, &mut reservation)
            .unwrap()
            .unwrap();
        let request = start.read_request.unwrap();
        assert_eq!((request.disc_offset, request.length), (0, 0x20));
        fill_all_requests(&mut interface, 0x54);
        interface.service_resident(start.completion_cycle, &mut mem1, &mut reservation);
        assert_ne!(&mem1[0x400..0x420], &[0xcc; 0x20]);
        assert_eq!(&mem1[0x420..0x440], &[0xcc; 0x20]);
        assert_eq!(interface.dma_base.value(), 0x440);
    }

    #[test]
    fn range_short_overlong_and_host_failures_are_delayed_atomic_device_errors() {
        let mut interface = Interface::default();
        configure(&mut interface, 0x1000);
        let mut mem1 = ram(0x1000);
        let mut reservation = LoadStoreReservation::default();
        interface
            .write_resident_command_word(0, 0xa800_0000)
            .unwrap();
        interface.write_resident_command_word(1, 0x3f8).unwrap();
        interface.write_resident_command_word(2, 0x40).unwrap();
        interface.write_resident_dma_address(0x500).unwrap();
        interface.write_resident_dma_length(0x40).unwrap();
        let range = interface
            .write_resident_control(3, 5_000, &mut mem1, &mut reservation)
            .unwrap()
            .unwrap();
        assert!(range.read_request.is_none());
        assert_eq!(range.completion_cycle, 150_800);
        let ResidentServiceState::Completed(range_completion) = interface
            .service_resident(range.completion_cycle, &mut mem1, &mut reservation)
            .command
        else {
            panic!("expected range completion");
        };
        assert_eq!(range_completion.error_code, ERROR_BLOCK_OUT_OF_BOUNDS);
        assert_eq!(&mem1[0x500..0x540], &[0xcc; 0x40]);
        assert_eq!(interface.dma_base.value(), 0x500);
        assert_eq!(interface.dma_length, 0x40);

        for outcome in ["short", "overlong", "failure"] {
            let mut interface = Interface::default();
            configure(&mut interface, 0x20_0000);
            let mut mem1 = ram(0x1000);
            let mut reservation = LoadStoreReservation::default();
            reservation.reserve(Address(0x200));
            let start = program_read(
                &mut interface,
                &mut mem1,
                &mut reservation,
                6_000,
                0x40,
                0x40,
            );
            let request = start.read_request.unwrap();
            let error = match outcome {
                "short" => interface
                    .complete_resident_disc_read(request, 0x20)
                    .unwrap_err(),
                "overlong" => interface
                    .complete_resident_disc_read(request, 0x41)
                    .unwrap_err(),
                _ => {
                    interface.fail_resident_disc_read(request).unwrap();
                    DiscReadCompletionError::NoPendingRead
                }
            };
            if outcome == "short" {
                assert!(matches!(error, DiscReadCompletionError::ShortRead { .. }));
            } else if outcome == "overlong" {
                assert!(matches!(
                    error,
                    DiscReadCompletionError::OverlongRead { .. }
                ));
            }
            let ResidentServiceState::Completed(completion) = interface
                .service_resident(start.completion_cycle, &mut mem1, &mut reservation)
                .command
            else {
                panic!("expected failed read completion");
            };
            assert_eq!(completion.error_code, ERROR_READ);
            assert_eq!(completion.memory_write_bytes, 0);
            assert!(reservation.is_valid());
            assert_eq!(&mem1[0x200..0x240], &[0xcc; 0x40]);
        }
    }

    #[test]
    fn request_identity_rejects_mismatch_reordering_duplicates_and_stale_epochs() {
        let mut interface = Interface::default();
        configure(&mut interface, 0x20_0000);
        let mut mem1 = ram(0x10_0000);
        let mut reservation = LoadStoreReservation::default();
        let start = program_read(
            &mut interface,
            &mut mem1,
            &mut reservation,
            0,
            MAX_DISC_READ_CHUNK_BYTES + 0x20,
            MAX_DISC_READ_CHUNK_BYTES + 0x20,
        );
        let first = start.read_request.unwrap();
        let mismatched = DiscReadRequest {
            length: first.length - 1,
            ..first
        };
        assert!(matches!(
            interface.complete_resident_disc_read(mismatched, mismatched.length),
            Err(DiscReadCompletionError::DescriptorMismatch { .. })
        ));
        let future = DiscReadRequest {
            id: first.id + 1,
            disc_offset: first.disc_offset + u64::from(first.length),
            length: 0x20,
            ..first
        };
        assert!(matches!(
            interface.complete_resident_disc_read(future, future.length),
            Err(DiscReadCompletionError::OutOfOrderRequest { .. })
        ));
        interface
            .complete_resident_disc_read(first, first.length)
            .unwrap();
        assert!(matches!(
            interface.complete_resident_disc_read(first, first.length),
            Err(DiscReadCompletionError::StaleRequest { .. })
        ));
        let second = interface.resident_read_request().unwrap();
        assert_eq!(second, future);
        interface.reset_resident().unwrap();
        assert!(matches!(
            interface.complete_resident_disc_read(second, second.length),
            Err(DiscReadCompletionError::StaleRequest { .. })
        ));
    }

    #[test]
    fn resident_reset_signal_is_one_shot_coalescing_and_wrap_safe() {
        let mut interface = Interface {
            resident_reset_generation: ResidentResetGeneration(u64::MAX - 1),
            ..Interface::default()
        };
        interface
            .synchronize_resident_ai_state(true, ai::SampleRate::KHz48, 0)
            .unwrap();

        interface.reset_resident().unwrap();
        interface.reset_resident().unwrap();
        assert_eq!(interface.resident_reset_generation().value(), 0);
        assert!(interface.resident_reset_pending());
        assert_eq!(
            interface.take_resident_reset(),
            Some(ResidentResetGeneration(0))
        );
        assert!(!interface.resident_reset_pending());
        assert_eq!(interface.take_resident_reset(), None);

        // The cached cross-device AI wire survives a DVD-only reset. A later DTK start therefore
        // observes the current AI state without waiting for another AISCR write.
        assert!(interface.resident.audio.ai_playing);
        assert_eq!(
            interface.resident.audio.ai_sample_rate,
            ai::SampleRate::KHz48
        );

        interface.reset_resident().unwrap();
        assert_eq!(interface.resident_reset_generation().value(), 1);
        assert_eq!(
            interface.take_resident_reset(),
            Some(ResidentResetGeneration(1))
        );
        assert_eq!(interface.take_resident_reset(), None);
    }

    #[test]
    fn reset_accounts_for_pending_inquiry_cancellation() {
        let mut interface = Interface::default();
        let mut mem1 = ram(0x1000);
        let mut reservation = LoadStoreReservation::default();
        interface
            .write_resident_command_word(0, 0x1200_0000)
            .unwrap();
        interface.write_resident_dma_address(0x200).unwrap();
        interface.write_resident_dma_length(0x20).unwrap();
        let start = interface
            .write_resident_control(3, 1_000, &mut mem1, &mut reservation)
            .unwrap()
            .unwrap();
        assert_eq!(start.kind, ResidentCommandKind::Inquiry);
        let live = interface.resident_di_lifecycle_evidence().unwrap();
        assert_eq!(live.command_starts, 1);
        assert_eq!(live.inquiry_starts, 1);
        assert_eq!(
            live.current_state,
            ResidentDiLifecycleState::AwaitingDeadline
        );
        assert_eq!(live.current_kind, Some(ResidentCommandKind::Inquiry));

        interface.reset_resident().unwrap();
        let cancelled = interface.resident_di_lifecycle_evidence().unwrap();
        assert_eq!(cancelled.command_starts, 1);
        assert_eq!(cancelled.command_completions, 0);
        assert_eq!(cancelled.command_cancellations, 1);
        assert_eq!(cancelled.inquiry_starts, 1);
        assert_eq!(cancelled.inquiry_completions, 0);
        assert_eq!(cancelled.inquiry_cancellations, 1);
        assert_eq!(cancelled.current_state, ResidentDiLifecycleState::Idle);
        assert_eq!(cancelled.current_kind, None);
    }

    #[test]
    fn reset_accounts_for_pending_read_cancellation() {
        let mut interface = Interface::default();
        configure(&mut interface, 0x20_0000);
        let mut mem1 = ram(0x1000);
        let mut reservation = LoadStoreReservation::default();
        let start = program_read(&mut interface, &mut mem1, &mut reservation, 0, 0x20, 0x20);
        assert!(start.read_request.is_some());
        let live = interface.resident_di_lifecycle_evidence().unwrap();
        assert_eq!(live.command_starts, 1);
        assert_eq!(live.read_starts, 1);
        assert_eq!(live.read_sector_starts, 1);
        assert_eq!(live.current_state, ResidentDiLifecycleState::AwaitingHost);
        assert_eq!(live.current_kind, Some(ResidentCommandKind::ReadSector));

        interface.reset_resident().unwrap();
        let cancelled = interface.resident_di_lifecycle_evidence().unwrap();
        assert_eq!(cancelled.command_starts, 1);
        assert_eq!(cancelled.command_completions, 0);
        assert_eq!(cancelled.command_cancellations, 1);
        assert_eq!(cancelled.read_starts, 1);
        assert_eq!(cancelled.read_completions, 0);
        assert_eq!(cancelled.read_cancellations, 1);
        assert_eq!(cancelled.current_state, ResidentDiLifecycleState::Idle);
        assert_eq!(cancelled.current_kind, None);
    }

    #[test]
    fn reset_clears_start_pending_without_cancelling_an_unaccepted_command() {
        let mut interface = Interface::default();
        interface
            .write_resident_command_word(0, 0x1200_0000)
            .unwrap();
        assert_eq!(interface.program_resident_control(3), Ok(3));
        let pending = interface.resident_di_lifecycle_evidence().unwrap();
        assert_eq!(pending.command_starts, 0);
        assert_eq!(pending.command_cancellations, 0);
        assert_eq!(
            pending.current_state,
            ResidentDiLifecycleState::StartPending
        );
        assert_eq!(pending.current_kind, Some(ResidentCommandKind::Inquiry));

        interface.reset_resident().unwrap();
        let cleared = interface.resident_di_lifecycle_evidence().unwrap();
        assert_eq!(cleared.command_starts, 0);
        assert_eq!(cleared.command_cancellations, 0);
        assert_eq!(cleared.inquiry_cancellations, 0);
        assert_eq!(cleared.read_cancellations, 0);
        assert_eq!(cleared.current_state, ResidentDiLifecycleState::Idle);
        assert_eq!(cleared.current_kind, None);
    }

    #[test]
    fn busy_programming_and_retrigger_preserve_the_latched_transaction() {
        let mut interface = Interface::default();
        configure(&mut interface, 0x20_0000);
        let mut mem1 = ram(0x1000);
        let mut reservation = LoadStoreReservation::default();
        let start = program_read(
            &mut interface,
            &mut mem1,
            &mut reservation,
            7_000,
            0x20,
            0x20,
        );
        let request = start.read_request.unwrap();
        assert!(matches!(
            interface.write_resident_command_word(0, 0x9900_0000),
            Err(ResidentRegisterWriteError::Busy { .. })
        ));
        assert!(matches!(
            interface.write_resident_dma_address(0x800),
            Err(ResidentRegisterWriteError::Busy { .. })
        ));
        assert!(matches!(
            interface.write_resident_control(3, 7_010, &mut mem1, &mut reservation),
            Err(ResidentStartError::Busy { .. })
        ));
        assert_eq!(interface.resident_read_request(), Some(request));
        assert_eq!(interface.command_buffer[0], 0xa800_0000);
        assert_eq!(interface.dma_base.value(), 0x200);
    }

    #[test]
    fn zero_unknown_and_partial_mem1_inputs_fail_closed_without_starting() {
        let mut interface = Interface::default();
        configure(&mut interface, 0x20_0000);
        let mut mem1 = ram(0x1000);
        let mut reservation = LoadStoreReservation::default();
        interface
            .write_resident_command_word(0, 0xa800_0000)
            .unwrap();
        interface.write_resident_command_word(2, 0).unwrap();
        interface.write_resident_dma_length(0x20).unwrap();
        assert_eq!(
            interface.write_resident_control(3, 0, &mut mem1, &mut reservation),
            Err(ResidentStartError::ZeroRequestedLength)
        );
        interface.write_resident_command_word(2, 0x20).unwrap();
        interface.write_resident_dma_length(0x1f).unwrap();
        assert_eq!(
            interface.write_resident_control(3, 0, &mut mem1, &mut reservation),
            Err(ResidentStartError::ZeroDmaLength)
        );
        interface.write_resident_dma_length(0x40).unwrap();
        interface.write_resident_dma_address(0x0fe0).unwrap();
        interface.write_resident_command_word(2, 0x40).unwrap();
        assert_eq!(
            interface.write_resident_control(3, 0, &mut mem1, &mut reservation),
            Err(ResidentStartError::Mem1Range {
                dma_address: 0x0fe0,
                length: 0x40,
                valid_prefix_bytes: 0x20,
            })
        );
        assert!(interface.resident_deadlines().completion.is_none());
    }

    #[test]
    fn invalid_modes_commands_unknown_disc_and_identity_exhaustion_preserve_state() {
        let mut interface = Interface::default();
        let mut mem1 = ram(0x1000);
        let mut reservation = LoadStoreReservation::default();
        interface
            .write_resident_command_word(0, 0xa800_0000)
            .unwrap();
        interface.write_resident_command_word(2, 0x20).unwrap();
        interface.write_resident_dma_address(0x200).unwrap();
        interface.write_resident_dma_length(0x20).unwrap();
        assert_eq!(
            interface.write_resident_control(1, 0, &mut mem1, &mut reservation),
            Err(ResidentStartError::InvalidControlMode { control: 1 })
        );
        assert_eq!(interface.command_buffer[0], 0xa800_0000);
        assert_eq!(interface.dma_base.value(), 0x200);
        assert!(!interface.control.transfer_ongoing());

        assert_eq!(
            interface.write_resident_control(3, 0, &mut mem1, &mut reservation),
            Err(ResidentStartError::DiscRangeUnknown)
        );
        configure(&mut interface, 0x20_0000);
        interface
            .write_resident_command_word(0, 0xa800_0041)
            .unwrap();
        assert_eq!(
            interface.write_resident_control(3, 0, &mut mem1, &mut reservation),
            Err(ResidentStartError::InvalidReadSubcommand(0x41))
        );

        interface
            .write_resident_command_word(0, 0xa800_0000)
            .unwrap();
        interface.resident.next_request_id = u64::MAX;
        assert_eq!(
            interface.write_resident_control(3, 0, &mut mem1, &mut reservation),
            Err(ResidentStartError::RequestIdExhausted)
        );
        assert_eq!(interface.resident_payload_bytes(), 0);
        assert!(interface.resident.pending.is_none());
    }

    #[test]
    fn cycle_and_epoch_exhaustion_are_typed_and_leave_live_state_untouched() {
        let mut interface = Interface::default();
        let mut mem1 = ram(0x1000);
        let mut reservation = LoadStoreReservation::default();
        interface
            .write_resident_command_word(0, 0x1200_0000)
            .unwrap();
        interface.write_resident_dma_address(0x200).unwrap();
        interface.write_resident_dma_length(0x20).unwrap();
        assert_eq!(
            interface.write_resident_control(3, u64::MAX, &mut mem1, &mut reservation),
            Err(ResidentStartError::CycleOverflow)
        );
        assert_eq!(&mem1[0x200..0x20c], &[0xcc; 12]);
        assert!(interface.resident.pending.is_none());

        interface.resident.epoch = u64::MAX;
        assert_eq!(
            interface.configure_resident_disc(Some(0x1000)),
            Err(ResidentDiscConfigError::EpochExhausted)
        );
        assert_eq!(
            interface.reset_resident(),
            Err(ResidentResetError::EpochExhausted)
        );
        assert_eq!(interface.command_buffer[0], 0x1200_0000);
        assert_eq!(interface.resident_reset_generation().value(), 0);
        assert!(!interface.resident_reset_pending());
    }

    #[test]
    fn guest_reset_propagates_epoch_exhaustion_without_authoring_a_false_latch() {
        let mut sys = test_system();
        sys.disk.command_buffer[0] = 0xa800_0000;
        sys.disk.resident.epoch = u64::MAX;

        assert_eq!(
            reset(&mut sys, 1 << 2),
            Err(ResidentResetError::EpochExhausted)
        );
        assert_eq!(sys.disk.command_buffer[0], 0xa800_0000);
        assert_eq!(sys.disk.resident_reset_generation().value(), 0);
        assert!(!sys.disk.resident_reset_pending());
    }

    #[test]
    fn final_chunk_duplicate_and_wrong_epoch_cannot_change_ready_payload() {
        let mut interface = Interface::default();
        configure(&mut interface, 0x20_0000);
        let mut mem1 = ram(0x1000);
        let mut reservation = LoadStoreReservation::default();
        let start = program_read(&mut interface, &mut mem1, &mut reservation, 0, 0x20, 0x20);
        let request = start.read_request.unwrap();
        interface
            .resident_read_staging_mut(request)
            .unwrap()
            .fill(0xa5);
        let wrong_epoch = DiscReadRequest {
            epoch: request.epoch + 1,
            ..request
        };
        assert!(matches!(
            interface.complete_resident_disc_read(wrong_epoch, request.length),
            Err(DiscReadCompletionError::DescriptorMismatch { .. })
        ));
        interface
            .complete_resident_disc_read(request, request.length)
            .unwrap();
        assert!(matches!(
            interface.complete_resident_disc_read(request, request.length),
            Err(DiscReadCompletionError::ResultAlreadyProvided { .. })
        ));
        let ResidentServiceState::Completed(completion) = interface
            .service_resident(start.completion_cycle, &mut mem1, &mut reservation)
            .command
        else {
            panic!("expected completion");
        };
        assert!(completion.successful);
        assert_eq!(&mem1[0x200..0x220], &[0xa5; 0x20]);
    }

    #[test]
    fn completion_revalidates_mem1_and_turns_adapter_mismatch_into_read_error() {
        let mut interface = Interface::default();
        configure(&mut interface, 0x20_0000);
        let mut start_mem1 = ram(0x1000);
        let mut reservation = LoadStoreReservation::default();
        let start = program_read(
            &mut interface,
            &mut start_mem1,
            &mut reservation,
            0,
            0x20,
            0x20,
        );
        fill_all_requests(&mut interface, 0x88);
        let mut wrong_mem1 = ram(0x200);
        let ResidentServiceState::Completed(completion) = interface
            .service_resident(start.completion_cycle, &mut wrong_mem1, &mut reservation)
            .command
        else {
            panic!("expected completion");
        };
        assert!(!completion.successful);
        assert_eq!(completion.error_code, ERROR_READ);
        assert_eq!(completion.memory_write_bytes, 0);
    }

    #[test]
    fn request_error_and_unsupported_commands_complete_without_panicking() {
        let mut interface = Interface::default();
        let mut mem1 = ram(0x1000);
        let mut reservation = LoadStoreReservation::default();
        interface.resident.last_error = ERROR_READ;
        interface
            .write_resident_command_word(0, 0xe000_0000)
            .unwrap();
        let status = interface
            .write_resident_control(1, 100, &mut mem1, &mut reservation)
            .unwrap()
            .unwrap();
        assert_eq!(interface.immediate & 0x00ff_ffff, ERROR_READ);
        let ResidentServiceState::Completed(completion) = interface
            .service_resident(status.completion_cycle, &mut mem1, &mut reservation)
            .command
        else {
            panic!("expected status completion");
        };
        assert!(completion.successful);

        interface
            .write_resident_command_word(0, 0x9900_0000)
            .unwrap();
        let unsupported = interface
            .write_resident_control(1, 1_000, &mut mem1, &mut reservation)
            .unwrap()
            .unwrap();
        let ResidentServiceState::Completed(completion) = interface
            .service_resident(unsupported.completion_cycle, &mut mem1, &mut reservation)
            .command
        else {
            panic!("expected unsupported completion");
        };
        assert_eq!(completion.error_code, ERROR_INVALID_COMMAND);
        assert!(interface.status.device_err_interrupt());
    }

    #[test]
    fn deadlines_publish_completion_and_dtk_in_browser_service_slots() {
        let mut interface = Interface::default();
        let mut mem1 = ram(0x1000);
        let mut reservation = LoadStoreReservation::default();
        interface
            .write_resident_command_word(0, 0xe401_000a)
            .unwrap();
        let config = interface
            .write_resident_control(1, 0, &mut mem1, &mut reservation)
            .unwrap()
            .unwrap();
        interface.service_resident(config.completion_cycle, &mut mem1, &mut reservation);
        interface
            .synchronize_resident_ai_state(true, ai::SampleRate::KHz32, 200_000)
            .unwrap();
        interface
            .write_resident_command_word(0, 0xe100_0000)
            .unwrap();
        interface.write_resident_command_word(1, 0x100).unwrap();
        interface.write_resident_command_word(2, 0x1000).unwrap();
        let stream = interface
            .write_resident_control(1, 200_000, &mut mem1, &mut reservation)
            .unwrap()
            .unwrap();
        let mut deadlines = MachineEventDeadlines::default();
        interface.publish_resident_deadlines(&mut deadlines);
        assert_eq!(
            deadlines.deadline(MachineEventKind::DiskCompletion),
            Some(stream.completion_cycle)
        );
        assert_eq!(
            deadlines.deadline(MachineEventKind::DiskAudio),
            Some(200_000 + AUDIO_BATCH_CYCLES)
        );
        interface.service_resident(200_000 + AUDIO_BATCH_CYCLES, &mut mem1, &mut reservation);
        assert_eq!(interface.resident.audio.position, 0x400 + 4 * 32);
    }

    #[test]
    fn timing_splits_at_ecc_boundaries_with_floor_per_chunk() {
        assert_eq!(buffered_read_lower_bound_cycles(0x20, 0x400), Some(292_063));
        let first = 0x10_u64 * CPU_CYCLES_PER_SECOND / BUFFER_TRANSFER_BYTES_PER_SECOND;
        let second = 0x30_u64 * CPU_CYCLES_PER_SECOND / BUFFER_TRANSFER_BYTES_PER_SECOND;
        assert_eq!(
            buffered_read_lower_bound_cycles(0x40, DVD_ECC_BLOCK_BYTES - 0x10),
            Some(READ_START_LATENCY_CYCLES + first + second)
        );
    }

    #[test]
    fn maximum_legal_payload_is_bounded_and_windowed_without_a_second_buffer() {
        let mut interface = Interface::default();
        configure(&mut interface, RAM_LEN as u64);
        let mut mem1 = vec![0; RAM_LEN];
        let mut reservation = LoadStoreReservation::default();
        interface
            .write_resident_command_word(0, 0xa800_0000)
            .unwrap();
        interface.write_resident_command_word(1, 0).unwrap();
        interface
            .write_resident_command_word(2, RAM_LEN as u32)
            .unwrap();
        interface.write_resident_dma_address(0).unwrap();
        interface.write_resident_dma_length(RAM_LEN as u32).unwrap();
        let start = interface
            .write_resident_control(3, 0, &mut mem1, &mut reservation)
            .unwrap()
            .unwrap();
        assert_eq!(
            interface.resident_payload_bytes(),
            MAX_RESIDENT_DI_PAYLOAD_BYTES
        );
        assert!(interface.resident_payload_capacity_bytes() >= RAM_LEN);
        assert_eq!(
            start.read_request.unwrap().length,
            MAX_DISC_READ_CHUNK_BYTES
        );
    }
}
