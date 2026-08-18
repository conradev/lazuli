//! Serial interface (SI).
//!
//! Rust owns the synchronous controller queue, SI mailboxes, commands, and deadlines. Browser
//! code only normalizes input into [`ControllerInputSample`] records and publishes them.

use bitos::bitos;
use bitos::integer::{u2, u7, u10};
use strum::FromRepr;

use crate::modules::input::ControllerState;
use crate::system::scheduler::{MachineEventDeadlines, MachineEventKind};
use crate::system::{System, pi};

pub const TRANSFER_LATENCY_CYCLES: u64 = 200;
pub const CONTROLLER_INPUT_QUEUE_CAPACITY: usize = 64;
pub const FIELD_POLL_OFFSET_HALF_LINES: u32 = 15;
pub const PAD_USE_ORIGIN: u16 = 0x0080;

const STATUS_ERROR_W1C: u32 = 0x0f0f_0f0f;
const STATUS_OUTPUT_NOT_COPIED: u32 = 0x1010_1010;
const STATUS_COPY_BUFFERS: u32 = 0x8000_0000;
const CONTROL_TRANSFER_START: u32 = 0x0000_0001;
const CONTROL_READ_INTERRUPT: u32 = 0x1000_0000;
const CONTROL_COMMUNICATION_ERROR: u32 = 0x2000_0000;
const CONTROL_TRANSFER_INTERRUPT: u32 = 0x8000_0000;
const CONTROL_WRITABLE: u32 = 0x4fff_fffe;

#[bitos(1)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DeviceKind {
    Nintendo64 = 0,
    #[default]
    GameCube   = 1,
}

#[bitos(16)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeviceDescriptor {
    #[bits(8)]
    pub standard: bool,
    #[bits(11)]
    pub kind: DeviceKind,
    #[bits(13)]
    pub no_rumble: bool,
}

impl Default for DeviceDescriptor {
    fn default() -> Self {
        Self(0)
            .with_standard(true)
            .with_kind(DeviceKind::GameCube)
            .with_no_rumble(true)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, FromRepr)]
#[repr(u8)]
enum Command {
    Info      = 0x00,
    Poll      = 0x40,
    GetOrigin = 0x41,
    Calibrate = 0x42,
}

#[bitos(32)]
#[derive(Debug, Clone, Copy, Default)]
pub struct Poll {
    #[bits(0..4)]
    pub copy_mode: [bool; 4],
    #[bits(4..8)]
    pub port_enable: [bool; 4],
    #[bits(8..16)]
    pub poll_per_frame: u8,
    #[bits(16..26)]
    pub x_lines: u10,
}

#[bitos(32)]
#[derive(Debug, Clone, Copy, Default)]
pub struct CommControl {
    #[bits(0)]
    pub transfer_start: bool,
    #[bits(1..3)]
    pub channel: u2,
    #[bits(6)]
    pub enable_callback: bool,
    #[bits(7)]
    pub enable_command: bool,
    #[bits(8..15)]
    pub input_length: u7,
    #[bits(16..23)]
    pub output_length: u7,
    #[bits(24)]
    pub enable_channel: bool,
    #[bits(25..27)]
    pub channel_number: u2,
    #[bits(27)]
    pub read_interrupt_mask: bool,
    #[bits(28)]
    pub read_interrupt: bool,
    #[bits(29)]
    pub communication_error: bool,
    #[bits(30)]
    pub transfer_interrupt_mask: bool,
    #[bits(31)]
    pub transfer_interrupt: bool,
}

#[bitos(6)]
#[derive(Debug, Clone, Copy, Default)]
pub struct ChannelStatus {
    #[bits(0)]
    pub underrun: bool,
    #[bits(1)]
    pub overrun: bool,
    #[bits(2)]
    pub collision: bool,
    #[bits(3)]
    pub no_response: bool,
    #[bits(4)]
    pub output_not_copied: bool,
    #[bits(5)]
    pub input_ready: bool,
}

#[bitos(32)]
#[derive(Debug, Clone, Copy, Default)]
pub struct Status {
    #[bits(0..6)]
    pub channel3: ChannelStatus,
    #[bits(8..14)]
    pub channel2: ChannelStatus,
    #[bits(16..22)]
    pub channel1: ChannelStatus,
    #[bits(24..30)]
    pub channel0: ChannelStatus,
    #[bits(31)]
    pub copy_buffers: bool,
}

impl Status {
    pub fn channel(&self, n: usize) -> ChannelStatus {
        match n {
            0 => self.channel0(),
            1 => self.channel1(),
            2 => self.channel2(),
            3 => self.channel3(),
            _ => panic!("out of range channel"),
        }
    }

    pub fn set_channel(&mut self, n: usize, value: ChannelStatus) {
        match n {
            0 => self.set_channel0(value),
            1 => self.set_channel1(value),
            2 => self.set_channel2(value),
            3 => self.set_channel3(value),
            _ => panic!("out of range channel"),
        };
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ChannelOutput {
    pub data: u32,
    pub dirty: bool,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ChannelInput {
    pub low: u32,
    pub high: u32,
}

/// Host-normalized state. DOM/Gamepad mapping and dead zones remain outside the machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct ControllerInputState {
    pub buttons: u16,
    pub stick_x: u8,
    pub stick_y: u8,
    pub c_stick_x: u8,
    pub c_stick_y: u8,
    pub trigger_l: u8,
    pub trigger_r: u8,
    pub analog_a: u8,
    pub analog_b: u8,
}

impl Default for ControllerInputState {
    fn default() -> Self {
        Self {
            buttons: 0,
            stick_x: 0x80,
            stick_y: 0x80,
            c_stick_x: 0x80,
            c_stick_y: 0x80,
            trigger_l: 0,
            trigger_r: 0,
            analog_a: 0,
            analog_b: 0,
        }
    }
}

impl ControllerInputState {
    /// Encodes this normalized state in the exact guest-visible packet format for `mode`.
    ///
    /// Keeping this pure encoder beside the source state lets Rust consumers authenticate that a
    /// typed publication and its packet describe the same input without reconstructing SI packing
    /// rules outside the device core.
    #[must_use]
    pub fn packet(self, mode: u8) -> [u8; 8] {
        let buttons = self.buttons | PAD_USE_ORIGIN;
        let low = match mode {
            0 | 5..=7 => [
                self.c_stick_x,
                self.c_stick_y,
                (self.trigger_l & 0xf0) | (self.trigger_r >> 4),
                (self.analog_a & 0xf0) | (self.analog_b >> 4),
            ],
            1 => [
                (self.c_stick_x & 0xf0) | (self.c_stick_y >> 4),
                self.trigger_l,
                self.trigger_r,
                (self.analog_a & 0xf0) | (self.analog_b >> 4),
            ],
            2 => [
                (self.c_stick_x & 0xf0) | (self.c_stick_y >> 4),
                (self.trigger_l & 0xf0) | (self.trigger_r >> 4),
                self.analog_a,
                self.analog_b,
            ],
            4 => [self.c_stick_x, self.c_stick_y, self.analog_a, self.analog_b],
            _ => [
                self.c_stick_x,
                self.c_stick_y,
                self.trigger_l,
                self.trigger_r,
            ],
        };
        [
            (buttons >> 8) as u8,
            buttons as u8,
            self.stick_x,
            self.stick_y,
            low[0],
            low[1],
            low[2],
            low[3],
        ]
    }
}

impl From<ControllerState> for ControllerInputState {
    fn from(state: ControllerState) -> Self {
        let mut buttons = 0_u16;
        buttons |= u16::from(state.pad_left);
        buttons |= u16::from(state.pad_right) << 1;
        buttons |= u16::from(state.pad_down) << 2;
        buttons |= u16::from(state.pad_up) << 3;
        buttons |= u16::from(state.trigger_z) << 4;
        buttons |= u16::from(state.trigger_right) << 5;
        buttons |= u16::from(state.trigger_left) << 6;
        buttons |= u16::from(state.button_a) << 8;
        buttons |= u16::from(state.button_b) << 9;
        buttons |= u16::from(state.button_x) << 10;
        buttons |= u16::from(state.button_y) << 11;
        buttons |= u16::from(state.button_start) << 12;
        Self {
            buttons,
            stick_x: state.analog_x,
            stick_y: state.analog_y,
            c_stick_x: state.analog_sub_x,
            c_stick_y: state.analog_sub_y,
            trigger_l: state.analog_trigger_left,
            trigger_r: state.analog_trigger_right,
            analog_a: if state.button_a { u8::MAX } else { 0 },
            analog_b: if state.button_b { u8::MAX } else { 0 },
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[repr(C)]
pub struct ControllerInputSample {
    pub sequence: u64,
    pub state: ControllerInputState,
}

impl ControllerInputSample {
    pub fn new(sequence: u64, state: ControllerInputState) -> Result<Self, ControllerInputError> {
        if sequence == 0 {
            return Err(ControllerInputError::ZeroSequence);
        }
        Ok(Self { sequence, state })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControllerInputError {
    ZeroSequence,
    NonMonotonicSequence { received: u64, last_received: u64 },
    QueueFull { capacity: usize },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControllerInputDisposition {
    Queued {
        depth: usize,
    },
    CoalescedQueued {
        replaced_sequence: u64,
        depth: usize,
    },
    AppliedEquivalent {
        replaced_sequence: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ControllerInputReceipt {
    pub sequence: u64,
    pub disposition: ControllerInputDisposition,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControllerPollSource {
    Periodic,
    Direct,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ControllerPublication {
    pub source: ControllerPollSource,
    pub poll_index: u64,
    pub scheduled_cycle: u64,
    pub observed_cycle: u64,
    pub sequence: u64,
    /// Buttons without PAD_USE_ORIGIN. Zero proves a neutral/released publication.
    pub buttons: u16,
    /// Exact normalized state consumed by this poll.
    pub state: ControllerInputState,
    /// Guest-selected SI packet mode used to encode `packet`.
    pub mode: u8,
    pub packet: [u8; 8],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelPollOutcome {
    Published(ControllerPublication),
    Backpressured,
    NoResponse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SerialPollCompletion {
    pub scheduled_cycle: u64,
    pub observed_cycle: u64,
    pub channels: [ChannelPollOutcome; 4],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SerialTransferOutcome {
    Success,
    NoResponse,
    ProtocolError,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SerialTransferIdentity {
    pub generation: u64,
    pub channel: u8,
    pub completion_cycle: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SerialTransferCompletion {
    pub identity: SerialTransferIdentity,
    pub observed_cycle: u64,
    pub command: u8,
    pub outcome: SerialTransferOutcome,
    pub publication: Option<ControllerPublication>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputCommandOutcome {
    Ignored,
    Applied { mode: u8, rumble: bool },
    ProtocolError { command: u8 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StatusWriteResult {
    pub cleared_errors: u32,
    pub output_commands: Option<[OutputCommandOutcome; 4]>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommControlWriteResult {
    pub started: Option<SerialTransferIdentity>,
    pub interrupt_active: bool,
}

/// Frozen VI-to-SI seam: VI owns this snapshot; SI owns recurrence from it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ViSerialTiming {
    pub display_enabled: bool,
    /// One exact observed-cycle anchor supplied by VI.
    pub anchor_cycle: u64,
    pub anchor_half_line: u32,
    /// Phase within `anchor_half_line`; this preserves VI origins before machine cycle zero.
    pub cycles_into_half_line: u64,
    pub cycles_per_half_line: u64,
    pub odd_half_lines: u32,
    pub total_half_lines: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SerialTimingError {
    ZeroCyclesPerHalfLine,
    ZeroHalfLines,
    InvalidOddField,
    AnchorHalfLineOutOfRange,
    CyclesIntoHalfLineOutOfRange,
    ObservedBeforeAnchor,
    CycleOverflow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SerialServiceError {
    Timing(SerialTimingError),
    ObservedBeforeScheduled { scheduled: u64, observed: u64 },
    PollIndexOverflow,
    TransferGenerationOverflow,
    TransferDeadlineOverflow,
    ServiceCountOverflow,
}

impl From<SerialTimingError> for SerialServiceError {
    fn from(error: SerialTimingError) -> Self {
        Self::Timing(error)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SerialServiceResult {
    Poll(SerialPollCompletion),
    Transfer(SerialTransferCompletion),
}

/// One complete serial service phase. PI is sampled only after this batch is fully drained.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SerialServiceSummary {
    pub periodic_polls: u64,
    pub backpressured_polls: u64,
    pub periodic_publication: Option<ControllerPublication>,
    pub transfer: Option<SerialTransferCompletion>,
    pub interrupt_active: bool,
}

pub struct Interface {
    pub channel_output: [ChannelOutput; 4],
    pub channel_input: [ChannelInput; 4],
    pub poll: Poll,
    pub comm_control: CommControl,
    pub status: Status,
    pub buffer: [u8; 128],
    controller_modes: [u8; 4],
    controller_rumble: [bool; 4],
    controller_queue: [ControllerInputSample; CONTROLLER_INPUT_QUEUE_CAPACITY],
    controller_queue_head: usize,
    controller_queue_len: usize,
    controller_last_received_sequence: u64,
    controller_active: ControllerInputSample,
    controller_poll_index: u64,
    next_poll_cycle: Option<u64>,
    poll_timing: Option<ViSerialTiming>,
    transfer_generation: u64,
    pending_transfer: Option<SerialTransferIdentity>,
}

impl Default for Interface {
    fn default() -> Self {
        Self {
            channel_output: [ChannelOutput::default(); 4],
            channel_input: [ChannelInput::default(); 4],
            poll: Poll::default(),
            comm_control: CommControl::default(),
            status: Status::default(),
            buffer: [0; 128],
            controller_modes: [3; 4],
            controller_rumble: [false; 4],
            controller_queue: [ControllerInputSample::default(); CONTROLLER_INPUT_QUEUE_CAPACITY],
            controller_queue_head: 0,
            controller_queue_len: 0,
            controller_last_received_sequence: 0,
            controller_active: ControllerInputSample::default(),
            controller_poll_index: 0,
            next_poll_cycle: None,
            poll_timing: None,
            transfer_generation: 0,
            pending_transfer: None,
        }
    }
}

impl ViSerialTiming {
    /// A cycle-anchored disabled timing image for servicing SI transfers while VI has no valid
    /// raster geometry. Periodic polling is suppressed, but a direct transfer can still complete.
    #[must_use]
    pub const fn disabled_at(anchor_cycle: u64) -> Self {
        Self {
            display_enabled: false,
            anchor_cycle,
            anchor_half_line: 0,
            cycles_into_half_line: 0,
            cycles_per_half_line: 1,
            odd_half_lines: 1,
            total_half_lines: 1,
        }
    }

    fn validate(self) -> Result<(), SerialTimingError> {
        if !self.display_enabled {
            return Ok(());
        }
        if self.cycles_per_half_line == 0 {
            return Err(SerialTimingError::ZeroCyclesPerHalfLine);
        }
        if self.total_half_lines == 0 {
            return Err(SerialTimingError::ZeroHalfLines);
        }
        if self.odd_half_lines == 0 || self.odd_half_lines > self.total_half_lines {
            return Err(SerialTimingError::InvalidOddField);
        }
        if self.anchor_half_line >= self.total_half_lines {
            return Err(SerialTimingError::AnchorHalfLineOutOfRange);
        }
        if self.cycles_into_half_line >= self.cycles_per_half_line {
            return Err(SerialTimingError::CyclesIntoHalfLineOutOfRange);
        }
        Ok(())
    }

    fn half_line_at(self, cycle: u64) -> Result<u32, SerialTimingError> {
        self.validate()?;
        if !self.display_enabled {
            return Err(SerialTimingError::ZeroHalfLines);
        }
        let elapsed = cycle
            .checked_sub(self.anchor_cycle)
            .ok_or(SerialTimingError::ObservedBeforeAnchor)?;
        let phased = self
            .cycles_into_half_line
            .checked_add(elapsed)
            .ok_or(SerialTimingError::CycleOverflow)?;
        let elapsed_half_lines = phased / self.cycles_per_half_line;
        Ok(((u64::from(self.anchor_half_line) + elapsed_half_lines)
            % u64::from(self.total_half_lines)) as u32)
    }

    fn cycle_for_half_line_after(
        self,
        target_half_line: u32,
        observed_cycle: u64,
    ) -> Result<u64, SerialTimingError> {
        self.validate()?;
        let total = u64::from(self.total_half_lines);
        let elapsed = observed_cycle
            .checked_sub(self.anchor_cycle)
            .ok_or(SerialTimingError::ObservedBeforeAnchor)?;
        let phased = self
            .cycles_into_half_line
            .checked_add(elapsed)
            .ok_or(SerialTimingError::CycleOverflow)?;
        let elapsed_half_lines = phased / self.cycles_per_half_line;
        let cycles_into_half_line = phased % self.cycles_per_half_line;
        let current = (u64::from(self.anchor_half_line) + elapsed_half_lines) % total;
        let target = u64::from(target_half_line) % total;
        let mut distance = (target + total - current) % total;
        if distance == 0 {
            distance = total;
        }
        let delta = distance
            .checked_mul(self.cycles_per_half_line)
            .ok_or(SerialTimingError::CycleOverflow)?;
        let future_delta = delta
            .checked_sub(cycles_into_half_line)
            .ok_or(SerialTimingError::CycleOverflow)?;
        observed_cycle
            .checked_add(future_delta)
            .ok_or(SerialTimingError::CycleOverflow)
    }

    fn initial_poll_cycle(
        self,
        poll: Poll,
        observed_cycle: u64,
    ) -> Result<Option<u64>, SerialTimingError> {
        self.validate()?;
        if !self.display_enabled {
            return Ok(None);
        }
        let interval = u32::from(poll.x_lines().value()) * 2;
        let fields = [
            (0, self.odd_half_lines, true),
            (self.odd_half_lines, self.total_half_lines, false),
        ];
        let mut selected = None;
        for (start, end, include_end) in fields {
            let mut target = start.saturating_add(FIELD_POLL_OFFSET_HALF_LINES);
            while target < end || (include_end && target == end) {
                let mapped = (target + 1) % self.total_half_lines;
                let cycle = self.cycle_for_half_line_after(mapped, observed_cycle)?;
                selected = Some(selected.map_or(cycle, |prior: u64| prior.min(cycle)));
                if interval == 0 {
                    break;
                }
                target = target
                    .checked_add(interval)
                    .ok_or(SerialTimingError::CycleOverflow)?;
            }
        }
        Ok(selected)
    }

    fn following_poll_cycle(
        self,
        poll: Poll,
        previous_cycle: u64,
    ) -> Result<Option<u64>, SerialTimingError> {
        self.validate()?;
        if !self.display_enabled {
            return Ok(None);
        }
        let mapped = self.half_line_at(previous_cycle)?;
        let current = (mapped + self.total_half_lines - 1) % self.total_half_lines;
        let interval = u32::from(poll.x_lines().value()) * 2;
        let target = if current < self.odd_half_lines {
            let candidate = current
                .checked_add(interval)
                .ok_or(SerialTimingError::CycleOverflow)?;
            if interval != 0 && candidate <= self.odd_half_lines {
                candidate
            } else {
                self.odd_half_lines
                    .checked_add(FIELD_POLL_OFFSET_HALF_LINES)
                    .ok_or(SerialTimingError::CycleOverflow)?
            }
        } else if current == self.odd_half_lines {
            self.odd_half_lines
                .checked_add(FIELD_POLL_OFFSET_HALF_LINES)
                .ok_or(SerialTimingError::CycleOverflow)?
        } else {
            let candidate = current
                .checked_add(interval)
                .ok_or(SerialTimingError::CycleOverflow)?;
            if interval != 0 && candidate < self.total_half_lines {
                candidate
            } else {
                FIELD_POLL_OFFSET_HALF_LINES
            }
        };
        let mapped_target = (target + 1) % self.total_half_lines;
        self.cycle_for_half_line_after(mapped_target, previous_cycle)
            .map(Some)
    }
}

impl Interface {
    pub fn any_interrupt(&self) -> bool {
        (self.comm_control.read_interrupt() && self.comm_control.read_interrupt_mask())
            || (self.comm_control.transfer_interrupt()
                && self.comm_control.transfer_interrupt_mask())
    }

    #[must_use]
    pub fn controller_mode(&self, channel: usize) -> Option<u8> {
        self.controller_modes.get(channel).copied()
    }

    #[must_use]
    pub fn controller_rumble(&self, channel: usize) -> Option<bool> {
        self.controller_rumble.get(channel).copied()
    }

    #[must_use]
    pub const fn controller_queue_len(&self) -> usize {
        self.controller_queue_len
    }

    #[must_use]
    pub const fn controller_applied_sequence(&self) -> u64 {
        self.controller_active.sequence
    }

    #[must_use]
    pub const fn controller_poll_index(&self) -> u64 {
        self.controller_poll_index
    }

    #[must_use]
    pub const fn controller_last_received_sequence(&self) -> u64 {
        self.controller_last_received_sequence
    }

    #[must_use]
    pub const fn next_poll_cycle(&self) -> Option<u64> {
        self.next_poll_cycle
    }

    #[must_use]
    pub const fn pending_transfer(&self) -> Option<SerialTransferIdentity> {
        self.pending_transfer
    }

    pub fn publish_controller_input(
        &mut self,
        sample: ControllerInputSample,
    ) -> Result<ControllerInputReceipt, ControllerInputError> {
        if sample.sequence == 0 {
            return Err(ControllerInputError::ZeroSequence);
        }
        if sample.sequence <= self.controller_last_received_sequence {
            return Err(ControllerInputError::NonMonotonicSequence {
                received: sample.sequence,
                last_received: self.controller_last_received_sequence,
            });
        }
        let disposition = if self.controller_queue_len != 0 {
            let tail = (self.controller_queue_head + self.controller_queue_len - 1)
                % CONTROLLER_INPUT_QUEUE_CAPACITY;
            if self.controller_queue[tail].state == sample.state {
                let replaced_sequence = self.controller_queue[tail].sequence;
                self.controller_queue[tail] = sample;
                ControllerInputDisposition::CoalescedQueued {
                    replaced_sequence,
                    depth: self.controller_queue_len,
                }
            } else {
                if self.controller_queue_len == CONTROLLER_INPUT_QUEUE_CAPACITY {
                    return Err(ControllerInputError::QueueFull {
                        capacity: CONTROLLER_INPUT_QUEUE_CAPACITY,
                    });
                }
                let index = (self.controller_queue_head + self.controller_queue_len)
                    % CONTROLLER_INPUT_QUEUE_CAPACITY;
                self.controller_queue[index] = sample;
                self.controller_queue_len += 1;
                ControllerInputDisposition::Queued {
                    depth: self.controller_queue_len,
                }
            }
        } else if self.controller_active.state == sample.state {
            let replaced_sequence = self.controller_active.sequence;
            self.controller_active = sample;
            ControllerInputDisposition::AppliedEquivalent { replaced_sequence }
        } else {
            self.controller_queue[self.controller_queue_head] = sample;
            self.controller_queue_len = 1;
            ControllerInputDisposition::Queued { depth: 1 }
        };
        self.controller_last_received_sequence = sample.sequence;
        Ok(ControllerInputReceipt {
            sequence: sample.sequence,
            disposition,
        })
    }

    fn pop_controller_input(&mut self) -> ControllerInputSample {
        if self.controller_queue_len == 0 {
            return self.controller_active;
        }
        let sample = self.controller_queue[self.controller_queue_head];
        self.controller_queue_head =
            (self.controller_queue_head + 1) % CONTROLLER_INPUT_QUEUE_CAPACITY;
        self.controller_queue_len -= 1;
        self.controller_active = sample;
        sample
    }

    fn packet_for_state(state: ControllerInputState, mode: u8) -> [u8; 8] {
        state.packet(mode)
    }

    fn controller_publication(
        &mut self,
        source: ControllerPollSource,
        scheduled_cycle: u64,
        observed_cycle: u64,
    ) -> Result<ControllerPublication, SerialServiceError> {
        if observed_cycle < scheduled_cycle {
            return Err(SerialServiceError::ObservedBeforeScheduled {
                scheduled: scheduled_cycle,
                observed: observed_cycle,
            });
        }
        let poll_index = self
            .controller_poll_index
            .checked_add(1)
            .ok_or(SerialServiceError::PollIndexOverflow)?;
        let sample = self.pop_controller_input();
        let mode = self.controller_modes[0];
        let packet = Self::packet_for_state(sample.state, mode);
        self.controller_poll_index = poll_index;
        Ok(ControllerPublication {
            source,
            poll_index,
            scheduled_cycle,
            observed_cycle,
            sequence: sample.sequence,
            buttons: sample.state.buttons,
            state: sample.state,
            mode,
            packet,
        })
    }

    fn refresh_read_interrupt(&mut self) {
        let ready = (0..4).any(|channel| self.status.channel(channel).input_ready());
        self.comm_control.set_read_interrupt(ready);
    }

    pub fn finish_input_read(&mut self, channel: usize) -> bool {
        if channel >= 4 {
            return false;
        }
        let mut status = self.status.channel(channel);
        let was_ready = status.input_ready();
        status.set_input_ready(false);
        self.status.set_channel(channel, status);
        self.refresh_read_interrupt();
        was_ready
    }

    fn set_no_response(&mut self, channel: usize) {
        let mut status = self.status.channel(channel);
        status.set_no_response(true);
        self.status.set_channel(channel, status);
    }

    fn perform_periodic_poll(
        &mut self,
        scheduled_cycle: u64,
        observed_cycle: u64,
    ) -> Result<SerialPollCompletion, SerialServiceError> {
        if observed_cycle < scheduled_cycle {
            return Err(SerialServiceError::ObservedBeforeScheduled {
                scheduled: scheduled_cycle,
                observed: observed_cycle,
            });
        }
        let channel_zero = if self.status.channel(0).input_ready() {
            ChannelPollOutcome::Backpressured
        } else {
            let preserved_error = self.channel_input[0].high & 0x4000_0000;
            let publication = self.controller_publication(
                ControllerPollSource::Periodic,
                scheduled_cycle,
                observed_cycle,
            )?;
            self.channel_input[0].high = u32::from_be_bytes([
                publication.packet[0],
                publication.packet[1],
                publication.packet[2],
                publication.packet[3],
            ]) | preserved_error;
            self.channel_input[0].low = u32::from_be_bytes([
                publication.packet[4],
                publication.packet[5],
                publication.packet[6],
                publication.packet[7],
            ]);
            let mut status = self.status.channel(0);
            status.set_input_ready(true);
            self.status.set_channel(0, status);
            ChannelPollOutcome::Published(publication)
        };
        for channel in 1..4 {
            self.set_no_response(channel);
            self.channel_input[channel].high |= 0xc000_0000;
        }
        self.refresh_read_interrupt();
        Ok(SerialPollCompletion {
            scheduled_cycle,
            observed_cycle,
            channels: [
                channel_zero,
                ChannelPollOutcome::NoResponse,
                ChannelPollOutcome::NoResponse,
                ChannelPollOutcome::NoResponse,
            ],
        })
    }

    fn process_output_command(&mut self, channel: usize) -> OutputCommandOutcome {
        let output = self.channel_output[channel].data;
        let command = (output >> 16) as u8;
        let mode = (output >> 8) as u8;
        let motor = output as u8;
        if channel != 0 || command == Command::Info as u8 {
            return OutputCommandOutcome::Ignored;
        }
        if command != Command::Poll as u8 {
            return OutputCommandOutcome::ProtocolError { command };
        }
        let rumble = motor == 1;
        self.controller_rumble[channel] = rumble;
        if !self.poll.port_enable_at(channel).unwrap() {
            self.controller_modes[channel] = mode;
        }
        OutputCommandOutcome::Applied {
            mode: self.controller_modes[channel],
            rumble,
        }
    }

    pub fn write_status(&mut self, value: Status) -> StatusWriteResult {
        let current = self.status.to_bits();
        let written = value.to_bits();
        let cleared_errors = current & written & STATUS_ERROR_W1C;
        let mut next = current & !cleared_errors;
        let output_commands = (written & STATUS_COPY_BUFFERS != 0).then(|| {
            let outcomes = std::array::from_fn(|channel| self.process_output_command(channel));
            next &= !(STATUS_COPY_BUFFERS | STATUS_OUTPUT_NOT_COPIED);
            for output in &mut self.channel_output {
                output.dirty = false;
            }
            outcomes
        });
        self.status = Status::from_bits(next);
        self.refresh_read_interrupt();
        StatusWriteResult {
            cleared_errors,
            output_commands,
        }
    }

    pub fn write_comm_control_at(
        &mut self,
        value: CommControl,
        observed_cycle: u64,
    ) -> Result<CommControlWriteResult, SerialServiceError> {
        let current = self.comm_control.to_bits();
        let written = value.to_bits();
        let started = if written & CONTROL_TRANSFER_START != 0 {
            let generation = self
                .transfer_generation
                .checked_add(1)
                .ok_or(SerialServiceError::TransferGenerationOverflow)?;
            let completion_cycle = observed_cycle
                .checked_add(TRANSFER_LATENCY_CYCLES)
                .ok_or(SerialServiceError::TransferDeadlineOverflow)?;
            Some(SerialTransferIdentity {
                generation,
                channel: ((written >> 1) & 3) as u8,
                completion_cycle,
            })
        } else {
            None
        };
        let read_interrupt =
            (current & CONTROL_READ_INTERRUPT) & !(written & CONTROL_READ_INTERRUPT);
        let communication_error = current & CONTROL_COMMUNICATION_ERROR;
        let transfer_interrupt =
            (current & CONTROL_TRANSFER_INTERRUPT) & !(written & CONTROL_TRANSFER_INTERRUPT);
        let transfer_start = (current | written) & CONTROL_TRANSFER_START;
        self.comm_control = CommControl::from_bits(
            (written & CONTROL_WRITABLE)
                | read_interrupt
                | communication_error
                | transfer_interrupt
                | transfer_start,
        );
        if let Some(identity) = started {
            self.transfer_generation = identity.generation;
            self.pending_transfer = Some(identity);
        }
        self.refresh_read_interrupt();
        Ok(CommControlWriteResult {
            started,
            interrupt_active: self.any_interrupt(),
        })
    }

    fn complete_transfer_at(
        &mut self,
        observed_cycle: u64,
    ) -> Result<Option<SerialTransferCompletion>, SerialServiceError> {
        let Some(identity) = self.pending_transfer else {
            return Ok(None);
        };
        if identity.completion_cycle > observed_cycle {
            return Ok(None);
        }
        let command = self.buffer[0];
        let (outcome, publication) = if identity.channel != 0 {
            (SerialTransferOutcome::NoResponse, None)
        } else {
            match Command::from_repr(command) {
                Some(Command::Info) => {
                    self.buffer[..3].copy_from_slice(&[0x09, 0x00, 0x00]);
                    (SerialTransferOutcome::Success, None)
                }
                Some(Command::Poll) => {
                    let publication = self.controller_publication(
                        ControllerPollSource::Direct,
                        identity.completion_cycle,
                        observed_cycle,
                    )?;
                    self.buffer[..8].copy_from_slice(&publication.packet);
                    (SerialTransferOutcome::Success, Some(publication))
                }
                Some(Command::GetOrigin | Command::Calibrate) => {
                    self.buffer[..10].copy_from_slice(&[
                        0x00, 0x00, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x00, 0x00,
                    ]);
                    (SerialTransferOutcome::Success, None)
                }
                None => (SerialTransferOutcome::ProtocolError, None),
            }
        };
        if outcome == SerialTransferOutcome::NoResponse {
            self.set_no_response(usize::from(identity.channel));
        }
        self.comm_control.set_transfer_start(false);
        self.comm_control
            .set_communication_error(outcome != SerialTransferOutcome::Success);
        self.comm_control.set_transfer_interrupt(true);
        self.pending_transfer = None;
        self.refresh_read_interrupt();
        Ok(Some(SerialTransferCompletion {
            identity,
            observed_cycle,
            command,
            outcome,
            publication,
        }))
    }

    pub fn synchronize_poll_timing(
        &mut self,
        timing: ViSerialTiming,
        observed_cycle: u64,
        deadlines: &mut MachineEventDeadlines,
    ) -> Result<Option<u64>, SerialTimingError> {
        let deadline = timing.initial_poll_cycle(self.poll, observed_cycle)?;
        self.next_poll_cycle = deadline;
        self.poll_timing = deadline.map(|_| timing);
        deadlines.set(MachineEventKind::SiPoll, deadline);
        Ok(deadline)
    }

    /// Clears VI-driven polling when no valid raster timing exists.
    ///
    /// Direct-transfer completion is independent and deliberately retained.
    pub fn clear_poll_timing(&mut self, deadlines: &mut MachineEventDeadlines) {
        self.next_poll_cycle = None;
        self.poll_timing = None;
        deadlines.clear(MachineEventKind::SiPoll);
    }

    pub fn publish_deadlines(&self, deadlines: &mut MachineEventDeadlines) {
        deadlines.set(MachineEventKind::SiPoll, self.next_poll_cycle);
        deadlines.set(
            MachineEventKind::SiTransferCompletion,
            self.pending_transfer
                .map(|transfer| transfer.completion_cycle),
        );
    }

    /// Services one transition. Repeated calls drain all due polls before transfer completion.
    pub fn service_next_due(
        &mut self,
        timing: ViSerialTiming,
        observed_cycle: u64,
        deadlines: &mut MachineEventDeadlines,
    ) -> Result<Option<SerialServiceResult>, SerialServiceError> {
        if let Some(scheduled_cycle) = self.next_poll_cycle
            && scheduled_cycle <= observed_cycle
        {
            // Validate recurrence before consuming a sample.
            let retained_timing = self.poll_timing.unwrap_or(timing);
            let following = retained_timing.following_poll_cycle(self.poll, scheduled_cycle)?;
            let completion = self.perform_periodic_poll(scheduled_cycle, observed_cycle)?;
            self.next_poll_cycle = following;
            if following.is_none() {
                self.poll_timing = None;
            }
            deadlines.set(MachineEventKind::SiPoll, following);
            return Ok(Some(SerialServiceResult::Poll(completion)));
        }
        if self
            .pending_transfer
            .is_some_and(|transfer| transfer.completion_cycle <= observed_cycle)
        {
            let Some(completion) = self.complete_transfer_at(observed_cycle)? else {
                unreachable!("due synchronous SI transfer disappeared")
            };
            deadlines.clear(MachineEventKind::SiTransferCompletion);
            return Ok(Some(SerialServiceResult::Transfer(completion)));
        }
        Ok(None)
    }

    fn replace_active_legacy_state(&mut self, state: ControllerInputState) {
        if self.controller_queue_len == 0 {
            self.controller_active.state = state;
        }
    }

    fn reject_pending_transfer(&mut self) {
        self.pending_transfer = None;
        self.comm_control.set_transfer_start(false);
        self.comm_control.set_communication_error(true);
        self.comm_control.set_transfer_interrupt(true);
    }
}

/// Legacy native polling seam. Browser integration uses typed publications and fixed deadlines.
pub fn poll_controller(sys: &mut System, channel: usize) {
    if channel >= 4 || !sys.serial.poll.port_enable_at(channel).unwrap() {
        return;
    }
    let controller = sys.modules.input.controller(channel);
    if channel != 0 || controller.is_none() {
        sys.serial.set_no_response(channel);
        sys.serial.refresh_read_interrupt();
        return;
    }
    if sys.serial.status.channel(channel).input_ready() {
        return;
    }
    sys.serial
        .replace_active_legacy_state(controller.unwrap().into());
    let observed = sys.scheduler.elapsed();
    if let Ok(publication) =
        sys.serial
            .controller_publication(ControllerPollSource::Periodic, observed, observed)
    {
        sys.serial.channel_input[channel].high = u32::from_be_bytes([
            publication.packet[0],
            publication.packet[1],
            publication.packet[2],
            publication.packet[3],
        ]);
        sys.serial.channel_input[channel].low = u32::from_be_bytes([
            publication.packet[4],
            publication.packet[5],
            publication.packet[6],
            publication.packet[7],
        ]);
        let mut status = sys.serial.status.channel(channel);
        status.set_input_ready(true);
        sys.serial.status.set_channel(channel, status);
        sys.serial.refresh_read_interrupt();
    }
}

fn do_transfer(sys: &mut System) {
    let observed_cycle = sys.scheduler.elapsed();
    let Some(pending) = sys.serial.pending_transfer else {
        return;
    };
    if pending.completion_cycle > observed_cycle {
        let remaining = pending.completion_cycle - observed_cycle;
        if sys.scheduler.try_schedule(remaining, do_transfer).is_err() {
            sys.serial.reject_pending_transfer();
            pi::check_interrupts(sys);
        }
        return;
    }
    if pending.channel == 0
        && sys.serial.controller_queue_len == 0
        && let Some(controller) = sys.modules.input.controller(0)
    {
        sys.serial.replace_active_legacy_state(controller.into());
    }
    if sys.serial.complete_transfer_at(observed_cycle).is_err() {
        sys.serial.reject_pending_transfer();
    }
    pi::check_interrupts(sys);
}

pub fn write_comm_control(sys: &mut System, value: CommControl) {
    let observed_cycle = sys.scheduler.elapsed();
    match sys.serial.write_comm_control_at(value, observed_cycle) {
        Ok(result) => {
            if result.started.is_some()
                && sys
                    .scheduler
                    .try_schedule(TRANSFER_LATENCY_CYCLES, do_transfer)
                    .is_err()
            {
                sys.serial.reject_pending_transfer();
                pi::check_interrupts(sys);
            }
        }
        Err(_) => {
            sys.serial.reject_pending_transfer();
            pi::check_interrupts(sys);
        }
    }
}

pub fn write_status(sys: &mut System, value: Status) {
    sys.serial.write_status(value);
    pi::check_interrupts(sys);
}

/// Drains the complete browser-authenticated SI phase and samples PI once afterward.
///
/// Periodic catch-up is therefore guaranteed to precede direct completion, including when the
/// direct transfer has an earlier scheduled cycle. At most one periodic publication can occur in
/// a batch because its one-entry mailbox backpressures all following polls until the guest reads
/// IN_HI or IN_LO.
pub fn service_due(
    sys: &mut System,
    timing: ViSerialTiming,
    observed_cycle: u64,
    deadlines: &mut MachineEventDeadlines,
) -> Result<SerialServiceSummary, SerialServiceError> {
    let mut summary = SerialServiceSummary::default();
    loop {
        let transition = match sys
            .serial
            .service_next_due(timing, observed_cycle, deadlines)
        {
            Ok(transition) => transition,
            Err(error) => {
                pi::check_interrupts(sys);
                return Err(error);
            }
        };
        match transition {
            Some(SerialServiceResult::Poll(poll)) => {
                summary.periodic_polls = summary
                    .periodic_polls
                    .checked_add(1)
                    .ok_or(SerialServiceError::ServiceCountOverflow)?;
                match poll.channels[0] {
                    ChannelPollOutcome::Published(publication) => {
                        summary.periodic_publication = Some(publication);
                    }
                    ChannelPollOutcome::Backpressured => {
                        summary.backpressured_polls = summary
                            .backpressured_polls
                            .checked_add(1)
                            .ok_or(SerialServiceError::ServiceCountOverflow)?;
                    }
                    ChannelPollOutcome::NoResponse => {}
                }
            }
            Some(SerialServiceResult::Transfer(transfer)) => {
                summary.transfer = Some(transfer);
            }
            None => break,
        }
    }
    summary.interrupt_active = sys.serial.any_interrupt();
    pi::check_interrupts(sys);
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(sequence: u64, buttons: u16) -> ControllerInputSample {
        ControllerInputSample::new(
            sequence,
            ControllerInputState {
                buttons,
                ..ControllerInputState::default()
            },
        )
        .unwrap()
    }

    fn timing() -> ViSerialTiming {
        ViSerialTiming {
            display_enabled: true,
            anchor_cycle: 0,
            anchor_half_line: 0,
            cycles_into_half_line: 0,
            cycles_per_half_line: 100,
            odd_half_lines: 20,
            total_half_lines: 40,
        }
    }

    #[test]
    fn browser_mode_three_neutral_and_press_packets_are_exact() {
        assert_eq!(
            Interface::packet_for_state(ControllerInputState::default(), 3),
            [0x00, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00]
        );
        let state = ControllerInputState {
            buttons: 0x0101,
            stick_x: 0x20,
            stick_y: 0xe0,
            c_stick_x: 0x11,
            c_stick_y: 0x22,
            trigger_l: 0x33,
            trigger_r: 0x44,
            analog_a: 0xff,
            ..ControllerInputState::default()
        };
        assert_eq!(
            Interface::packet_for_state(state, 3),
            [0x01, 0x81, 0x20, 0xe0, 0x11, 0x22, 0x33, 0x44]
        );
    }

    #[test]
    fn all_browser_controller_modes_pack_exact_low_words() {
        let state = ControllerInputState {
            c_stick_x: 0xab,
            c_stick_y: 0xcd,
            trigger_l: 0xe1,
            trigger_r: 0x2f,
            analog_a: 0x34,
            analog_b: 0x56,
            ..ControllerInputState::default()
        };
        let low = |mode| Interface::packet_for_state(state, mode)[4..].to_vec();
        assert_eq!(low(0), [0xab, 0xcd, 0xe2, 0x35]);
        assert_eq!(low(1), [0xac, 0xe1, 0x2f, 0x35]);
        assert_eq!(low(2), [0xac, 0xe2, 0x34, 0x56]);
        assert_eq!(low(3), [0xab, 0xcd, 0xe1, 0x2f]);
        assert_eq!(low(4), [0xab, 0xcd, 0x34, 0x56]);
        assert_eq!(low(0xfe), low(3));
    }

    #[test]
    fn press_then_release_remains_ordered_and_neutral_is_published() {
        let mut serial = Interface::default();
        serial.publish_controller_input(sample(1, 0x0100)).unwrap();
        serial.publish_controller_input(sample(2, 0)).unwrap();
        let pressed = serial
            .controller_publication(ControllerPollSource::Periodic, 10, 10)
            .unwrap();
        let released = serial
            .controller_publication(ControllerPollSource::Periodic, 20, 20)
            .unwrap();
        assert_eq!((pressed.sequence, pressed.buttons), (1, 0x0100));
        assert_eq!((released.sequence, released.buttons), (2, 0));
        assert_eq!(pressed.state.buttons, pressed.buttons);
        assert_eq!(pressed.mode, 3);
        assert_eq!(pressed.packet, pressed.state.packet(pressed.mode));
        assert_eq!(released.packet, released.state.packet(released.mode));
        assert_eq!(serial.controller_poll_index(), 2);
        assert_eq!(&released.packet[..2], &[0x00, PAD_USE_ORIGIN as u8]);
    }

    #[test]
    fn unread_mailbox_preserves_release_and_queue_order() {
        let mut serial = Interface::default();
        serial.publish_controller_input(sample(1, 0x0100)).unwrap();
        serial.publish_controller_input(sample(2, 0)).unwrap();
        assert!(matches!(
            serial.perform_periodic_poll(10, 10).unwrap().channels[0],
            ChannelPollOutcome::Published(_)
        ));
        assert_eq!(serial.controller_queue_len(), 1);
        assert_eq!(
            serial.perform_periodic_poll(20, 25).unwrap().channels[0],
            ChannelPollOutcome::Backpressured
        );
        assert_eq!(serial.controller_queue_len(), 1);
        assert!(serial.finish_input_read(0));
        let result = serial.perform_periodic_poll(30, 30).unwrap();
        let ChannelPollOutcome::Published(release) = result.channels[0] else {
            panic!("release was not published")
        };
        assert_eq!((release.sequence, release.buttons), (2, 0));
    }

    #[test]
    fn input_identity_is_monotonic_and_queue_full_fails_closed() {
        let mut serial = Interface::default();
        assert_eq!(
            serial.publish_controller_input(ControllerInputSample::default()),
            Err(ControllerInputError::ZeroSequence)
        );
        serial.publish_controller_input(sample(1, 1)).unwrap();
        assert_eq!(
            serial.publish_controller_input(sample(1, 2)),
            Err(ControllerInputError::NonMonotonicSequence {
                received: 1,
                last_received: 1,
            })
        );
        for sequence in 2..=CONTROLLER_INPUT_QUEUE_CAPACITY as u64 {
            serial
                .publish_controller_input(sample(sequence, sequence as u16))
                .unwrap();
        }
        let last = serial.controller_last_received_sequence();
        assert_eq!(
            serial.publish_controller_input(sample(last + 1, 0x7fff)),
            Err(ControllerInputError::QueueFull {
                capacity: CONTROLLER_INPUT_QUEUE_CAPACITY,
            })
        );
        assert_eq!(serial.controller_last_received_sequence(), last);
    }

    #[test]
    fn direct_transfer_completes_at_exact_two_hundred_cycle_identity() {
        let mut serial = Interface::default();
        serial.buffer[0] = 0x00;
        let identity = serial
            .write_comm_control_at(CommControl::from_bits(1), 1_000)
            .unwrap()
            .started
            .unwrap();
        assert_eq!(identity.completion_cycle, 1_200);
        assert!(serial.complete_transfer_at(1_199).unwrap().is_none());
        let completion = serial.complete_transfer_at(1_200).unwrap().unwrap();
        assert_eq!(completion.identity, identity);
        assert_eq!(completion.outcome, SerialTransferOutcome::Success);
        assert_eq!(&serial.buffer[..3], &[0x09, 0x00, 0x00]);
        assert!(!serial.comm_control.transfer_start());
        assert!(serial.comm_control.transfer_interrupt());
    }

    #[test]
    fn null_channel_and_unknown_command_fail_guest_visible_without_panicking() {
        let mut serial = Interface::default();
        serial.buffer[0] = 0x40;
        serial
            .write_comm_control_at(CommControl::from_bits(5), 0)
            .unwrap();
        let null = serial.complete_transfer_at(200).unwrap().unwrap();
        assert_eq!(null.identity.channel, 2);
        assert_eq!(null.outcome, SerialTransferOutcome::NoResponse);
        assert!(serial.status.channel(2).no_response());
        assert!(serial.comm_control.communication_error());

        serial.buffer[0] = 0x7e;
        serial
            .write_comm_control_at(CommControl::from_bits(1), 300)
            .unwrap();
        let invalid = serial.complete_transfer_at(500).unwrap().unwrap();
        assert_eq!(invalid.outcome, SerialTransferOutcome::ProtocolError);
        assert!(serial.comm_control.communication_error());
    }

    #[test]
    fn status_w1c_and_output_command_semantics_match_browser() {
        let mut serial = Interface {
            status: Status::from_bits(0x0f0f_0f0f),
            ..Interface::default()
        };
        serial.channel_output[0].data = 0x0040_0301;
        let result = serial.write_status(Status::from_bits(0x8800_0000));
        assert_eq!(result.cleared_errors, 0x0800_0000);
        assert_eq!(serial.status.to_bits(), 0x070f_0f0f);
        assert_eq!(
            result.output_commands.unwrap()[0],
            OutputCommandOutcome::Applied {
                mode: 3,
                rumble: true,
            }
        );
        assert_eq!(serial.controller_rumble(0), Some(true));
    }

    #[test]
    fn vi_derived_deadlines_and_mid_field_poll_update_match_browser() {
        let mut serial = Interface::default();
        serial.poll.set_x_lines(u10::new(2));
        let mut deadlines = MachineEventDeadlines::default();
        assert_eq!(
            serial
                .synchronize_poll_timing(timing(), 0, &mut deadlines)
                .unwrap(),
            Some(1_600)
        );
        serial.poll.set_x_lines(u10::new(1));
        assert_eq!(serial.next_poll_cycle(), Some(1_600));
        assert!(matches!(
            serial
                .service_next_due(timing(), 1_600, &mut deadlines)
                .unwrap(),
            Some(SerialServiceResult::Poll(_))
        ));
        assert_eq!(serial.next_poll_cycle(), Some(1_800));
    }

    #[test]
    fn observed_anchor_preserves_a_vi_phase_that_started_before_cycle_zero() {
        let mut serial = Interface::default();
        serial.poll.set_x_lines(u10::new(2));
        let timing = ViSerialTiming {
            cycles_into_half_line: 18,
            ..timing()
        };
        let mut deadlines = MachineEventDeadlines::default();
        // Half-line zero began at conceptual cycle -18. The next mapped target is half-line 16,
        // so its deadline is 16 * 100 - 18 without ever representing a negative absolute epoch.
        assert_eq!(
            serial
                .synchronize_poll_timing(timing, 0, &mut deadlines)
                .unwrap(),
            Some(1_582)
        );
    }

    #[test]
    fn overdue_poll_batch_retains_schedule_time_vi_phase_before_transfer() {
        let mut serial = Interface::default();
        serial.poll.set_x_lines(u10::new(2));
        serial.publish_controller_input(sample(1, 0x0001)).unwrap();
        serial.publish_controller_input(sample(2, 0x0002)).unwrap();
        let mut deadlines = MachineEventDeadlines::default();
        let schedule_timing = ViSerialTiming {
            // The field began before cycle zero. This produces an exact first poll at 1_582.
            cycles_into_half_line: 18,
            ..timing()
        };
        serial
            .synchronize_poll_timing(schedule_timing, 0, &mut deadlines)
            .unwrap();
        serial.buffer[0] = 0x00;
        serial
            .write_comm_control_at(CommControl::from_bits(1), 1_450)
            .unwrap();
        serial.publish_deadlines(&mut deadlines);

        // A fresh snapshot anchored at the late observation cannot evaluate the older 1_582
        // recurrence. SI must use the exact timing retained when that poll was scheduled, even if
        // VI has since changed its line duration.
        let changed_timing = ViSerialTiming {
            anchor_cycle: 2_100,
            cycles_per_half_line: 125,
            ..timing()
        };
        let first = serial
            .service_next_due(changed_timing, 2_100, &mut deadlines)
            .unwrap();
        let Some(SerialServiceResult::Poll(first)) = first else {
            panic!("the retained first poll must be serviced")
        };
        assert_eq!(first.scheduled_cycle, 1_582);
        let ChannelPollOutcome::Published(first_publication) = first.channels[0] else {
            panic!("the first queued input must publish")
        };
        assert_eq!(first_publication.sequence, 1);
        assert_eq!(first_publication.buttons, 0x0001);
        assert!(serial.finish_input_read(0));

        let second = serial
            .service_next_due(changed_timing, 2_100, &mut deadlines)
            .unwrap();
        let Some(SerialServiceResult::Poll(second)) = second else {
            panic!("the retained catch-up poll must precede the older transfer")
        };
        assert_eq!(second.scheduled_cycle, 1_982);
        let ChannelPollOutcome::Published(second_publication) = second.channels[0] else {
            panic!("the second queued input must publish")
        };
        assert_eq!(second_publication.sequence, 2);
        assert_eq!(second_publication.buttons, 0x0002);

        let third = serial
            .service_next_due(changed_timing, 2_100, &mut deadlines)
            .unwrap();
        let Some(SerialServiceResult::Transfer(third)) = third else {
            panic!("the overdue direct transfer must complete after the poll batch")
        };
        assert_eq!(third.identity.completion_cycle, 1_650);
        assert_eq!(third.observed_cycle, 2_100);

        // A VI timing reschedule atomically replaces both the deadline and its recurrence image.
        let replacement = serial
            .synchronize_poll_timing(changed_timing, 2_100, &mut deadlines)
            .unwrap();
        assert_eq!(deadlines.deadline(MachineEventKind::SiPoll), replacement);
    }

    #[test]
    fn invalid_timing_fails_before_consuming_input() {
        let mut serial = Interface::default();
        serial.publish_controller_input(sample(1, 1)).unwrap();
        serial.next_poll_cycle = Some(10);
        let invalid = ViSerialTiming {
            cycles_per_half_line: 0,
            ..timing()
        };
        let mut deadlines = MachineEventDeadlines::default();
        assert_eq!(
            serial.service_next_due(invalid, 10, &mut deadlines),
            Err(SerialServiceError::Timing(
                SerialTimingError::ZeroCyclesPerHalfLine
            ))
        );
        assert_eq!(serial.controller_queue_len(), 1);
        assert_eq!(serial.controller_applied_sequence(), 0);
    }
}
