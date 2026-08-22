//! Rust-owned, title-specific gameplay fidelity evidence.
//!
//! This module is deliberately not part of the default browser-machine artifact. Release
//! qualification enables `game-fidelity-probes`, feeds it authenticated Rust commit records, and
//! may expose only [`GameFidelityRecord::to_bytes`]. Guest addresses, pointer values, and memory
//! bytes remain private to Rust.

#![cfg(feature = "game-fidelity-probes")]

use lazuli::system::si::ControllerInputState;
pub use lazuli_abi::{RenderPresentationStatus, ViFieldParity, ViPresentationMode};
use sha2::{Digest, Sha256};

pub const GAME_FIDELITY_RECORD_VERSION: u32 = 1;
pub const GAME_FIDELITY_RECORD_BYTES: usize = 384;
const GAME_FIDELITY_RECORD_WORDS: usize = GAME_FIDELITY_RECORD_BYTES / 4;
const RECORD_MAGIC: u32 = u32::from_le_bytes(*b"GFP1");

pub(crate) const P_IDENTITY: u64 = 1 << 0;
const P_MILESTONE: u64 = 1 << 1;
pub(crate) const P_LIFETIME: u64 = 1 << 2;
pub(crate) const P_BASELINE_NEUTRAL: u64 = 1 << 3;
pub(crate) const P_PUBLICATION: u64 = 1 << 4;
pub(crate) const P_RECEIPT_SEQUENCE: u64 = 1 << 5;
const P_RECEIPT_INPUT: u64 = 1 << 6;
const P_POST_LIFETIME: u64 = 1 << 7;
pub(crate) const P_POST_ADVANCE: u64 = 1 << 8;
const P_CAUSAL_DELTA: u64 = 1 << 9;
pub(crate) const P_PRESENTATION: u64 = 1 << 10;

const COMMON_REQUIRED: u64 = P_IDENTITY
    | P_MILESTONE
    | P_LIFETIME
    | P_BASELINE_NEUTRAL
    | P_PUBLICATION
    | P_RECEIPT_SEQUENCE
    | P_RECEIPT_INPUT
    | P_POST_LIFETIME
    | P_POST_ADVANCE
    | P_CAUSAL_DELTA
    | P_PRESENTATION;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mem1ReadFault {
    Unmapped,
    CrossesMapping,
}

/// Narrow read boundary used by the projector. Implementations must translate the supplied guest
/// effective address and succeed only when the entire result is backed by MEM1.
pub trait CheckedMem1 {
    fn read_exact(&self, effective_address: u32, out: &mut [u8]) -> Result<(), Mem1ReadFault>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AuthenticatedDiscIdentity {
    pub id: [u8; 6],
    pub revision: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ProjectorId {
    WarioWareRepellionA  = 1,
    LuigisMansionFoyerLeft = 2,
    WindWakerOutsetLeft  = 3,
    MeleeActiveMatchLeft = 4,
    FzeroActiveRaceSteer = 5,
    MetroidPrimeFrigateLeftTurn = 6,
    RogueLeaderXwingLeftResponse = 7,
}

#[cfg_attr(
    test,
    allow(dead_code, reason = "exercised by path-based projector contracts")
)]
impl ProjectorId {
    #[cfg(test)]
    pub const fn oracle_id(self) -> &'static str {
        match self {
            Self::WarioWareRepellionA => "warioware-repellion-a-v2",
            Self::LuigisMansionFoyerLeft => "luigis-mansion-foyer-left-v1",
            Self::WindWakerOutsetLeft => "wind-waker-outset-left-v1",
            Self::MeleeActiveMatchLeft => "melee-active-match-left-v1",
            Self::FzeroActiveRaceSteer => "fzero-gx-active-race-steer-v1",
            Self::MetroidPrimeFrigateLeftTurn => "metroid-prime-frigate-left-turn-v1",
            Self::RogueLeaderXwingLeftResponse => "rogue-leader-xwing-left-control-response-v1",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ProbePhase {
    Unarmed   = 0,
    Baseline  = 1,
    Published = 2,
    Received  = 3,
    Posted    = 4,
    Accepted  = 5,
    Failed    = 6,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum FailureCode {
    None                = 0,
    UnsupportedIdentity = 1,
    WrongPhase          = 2,
    MemoryRead          = 3,
    Pointer             = 4,
    Range               = 5,
    NonFinite           = 6,
    Predicate           = 7,
    Chronology          = 8,
    Sequence            = 9,
    Lifetime            = 10,
    Presentation        = 11,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PublicationSource {
    Periodic = 1,
    Direct   = 2,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PresentationIdentity {
    pub render_sequence: u64,
    pub presentation_serial: u64,
    pub xfb_generation: u32,
    pub selected_row: u32,
    pub mode: ViPresentationMode,
    pub parity: ViFieldParity,
    pub pair_epoch: u32,
    pub output_width: u32,
    pub output_height: u32,
    pub status: RenderPresentationStatus,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ArmObservation {
    pub cycle: u64,
    pub controller_poll_index: u32,
    pub controller_applied_sequence: u64,
    pub presentation_cycle: u64,
    pub presentation: PresentationIdentity,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SiPublication {
    pub scheduled_cycle: u64,
    pub observed_cycle: u64,
    pub poll_index: u32,
    pub sequence: u64,
    pub source: PublicationSource,
    pub buttons: u32,
    pub state: ControllerInputState,
    pub mode: u8,
    pub packet: [u8; 8],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GuestReceipt {
    pub cycle: u64,
    pub poll_index: u32,
    pub applied_sequence: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PresentationObservation {
    pub cycle: u64,
    pub presentation: PresentationIdentity,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ProjectorSpec {
    identity: AuthenticatedDiscIdentity,
    id: ProjectorId,
    expected_input: ControllerInputState,
    required: u64,
}

const WARIO_A_INPUT: ControllerInputState = ControllerInputState {
    buttons: 0x0100,
    stick_x: 0x80,
    stick_y: 0x80,
    c_stick_x: 0x80,
    c_stick_y: 0x80,
    trigger_l: 0,
    trigger_r: 0,
    analog_a: u8::MAX,
    analog_b: 0,
};

const LEFT_INPUT: ControllerInputState = ControllerInputState {
    buttons: 0x0001,
    stick_x: 0x01,
    stick_y: 0x80,
    c_stick_x: 0x80,
    c_stick_y: 0x80,
    trigger_l: 0,
    trigger_r: 0,
    analog_a: 0,
    analog_b: 0,
};

const PROJECTORS: [ProjectorSpec; 7] = [
    ProjectorSpec {
        identity: AuthenticatedDiscIdentity {
            id: *b"GZWE01",
            revision: 0,
        },
        id: ProjectorId::WarioWareRepellionA,
        expected_input: WARIO_A_INPUT,
        required: COMMON_REQUIRED,
    },
    ProjectorSpec {
        identity: AuthenticatedDiscIdentity {
            id: *b"GLME01",
            revision: 0,
        },
        id: ProjectorId::LuigisMansionFoyerLeft,
        expected_input: LEFT_INPUT,
        required: COMMON_REQUIRED,
    },
    ProjectorSpec {
        identity: AuthenticatedDiscIdentity {
            id: *b"GZLE01",
            revision: 0,
        },
        id: ProjectorId::WindWakerOutsetLeft,
        expected_input: LEFT_INPUT,
        required: COMMON_REQUIRED,
    },
    ProjectorSpec {
        identity: AuthenticatedDiscIdentity {
            id: *b"GALE01",
            revision: 2,
        },
        id: ProjectorId::MeleeActiveMatchLeft,
        expected_input: LEFT_INPUT,
        required: COMMON_REQUIRED,
    },
    ProjectorSpec {
        identity: AuthenticatedDiscIdentity {
            id: *b"GFZE01",
            revision: 0,
        },
        id: ProjectorId::FzeroActiveRaceSteer,
        expected_input: LEFT_INPUT,
        required: COMMON_REQUIRED,
    },
    ProjectorSpec {
        identity: AuthenticatedDiscIdentity {
            id: *b"GM8E01",
            revision: 2,
        },
        id: ProjectorId::MetroidPrimeFrigateLeftTurn,
        expected_input: LEFT_INPUT,
        required: COMMON_REQUIRED,
    },
    ProjectorSpec {
        identity: AuthenticatedDiscIdentity {
            id: *b"GSWE64",
            revision: 0,
        },
        id: ProjectorId::RogueLeaderXwingLeftResponse,
        expected_input: LEFT_INPUT,
        required: COMMON_REQUIRED,
    },
];

#[derive(Clone, Copy, Debug)]
struct Vec3 {
    x: f32,
    y: f32,
    z: f32,
}

impl Vec3 {
    fn finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite() && self.z.is_finite()
    }

    fn distance_squared(self, other: Self) -> f32 {
        let x = self.x - other.x;
        let y = self.y - other.y;
        let z = self.z - other.z;
        x.mul_add(x, y.mul_add(y, z * z))
    }

    fn dot(self, other: Self) -> f32 {
        self.x
            .mul_add(other.x, self.y.mul_add(other.y, self.z * other.z))
    }

    fn push(self, out: &mut Vec<u8>) {
        push_f32(out, self.x);
        push_f32(out, self.y);
        push_f32(out, self.z);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProjectionStage {
    Baseline,
    Receipt,
    Post,
}

#[derive(Clone, Debug)]
enum TitleState {
    Wario(WarioState),
    Luigi(LuigiState),
    WindWaker(WindWakerState),
    Melee(MeleeState),
    Fzero(FzeroState),
    Metroid(MetroidState),
    Rogue(RogueState),
}

#[derive(Clone, Debug)]
struct Projection {
    hash: [u8; 32],
    lifetime_hash: [u8; 32],
    guest_input_witness: u32,
    state: TitleState,
}

#[derive(Clone, Copy, Debug)]
struct ProbeError {
    code: FailureCode,
    predicate: u64,
}

type ProbeResult<T> = Result<T, ProbeError>;

impl ProbeError {
    const fn new(code: FailureCode, predicate: u64) -> Self {
        Self { code, predicate }
    }
}

struct Reader<'a, M: CheckedMem1> {
    memory: &'a M,
    predicate: u64,
}

impl<'a, M: CheckedMem1> Reader<'a, M> {
    fn bytes<const N: usize>(&self, address: u32) -> ProbeResult<[u8; N]> {
        let mut bytes = [0; N];
        self.memory
            .read_exact(address, &mut bytes)
            .map_err(|_| ProbeError::new(FailureCode::MemoryRead, self.predicate))?;
        Ok(bytes)
    }

    fn u8(&self, address: u32) -> ProbeResult<u8> {
        Ok(self.bytes::<1>(address)?[0])
    }

    fn s8(&self, address: u32) -> ProbeResult<i8> {
        Ok(i8::from_be_bytes(self.bytes::<1>(address)?))
    }

    fn u16(&self, address: u32) -> ProbeResult<u16> {
        Ok(u16::from_be_bytes(self.bytes(address)?))
    }

    fn s16(&self, address: u32) -> ProbeResult<i16> {
        Ok(i16::from_be_bytes(self.bytes(address)?))
    }

    fn u32(&self, address: u32) -> ProbeResult<u32> {
        Ok(u32::from_be_bytes(self.bytes(address)?))
    }

    fn s32(&self, address: u32) -> ProbeResult<i32> {
        Ok(i32::from_be_bytes(self.bytes(address)?))
    }

    fn f32(&self, address: u32) -> ProbeResult<f32> {
        let value = f32::from_bits(self.u32(address)?);
        if !value.is_finite() {
            return Err(ProbeError::new(FailureCode::NonFinite, self.predicate));
        }
        Ok(value)
    }

    fn vec3(&self, address: u32) -> ProbeResult<Vec3> {
        let y = add_address(address, 4, self.predicate)?;
        let z = add_address(address, 8, self.predicate)?;
        Ok(Vec3 {
            x: self.f32(address)?,
            y: self.f32(y)?,
            z: self.f32(z)?,
        })
    }

    fn strided_vec3(&self, addresses: [u32; 3]) -> ProbeResult<Vec3> {
        Ok(Vec3 {
            x: self.f32(addresses[0])?,
            y: self.f32(addresses[1])?,
            z: self.f32(addresses[2])?,
        })
    }

    fn mem1_pointer(&self, value: u32, length: u32, aligned: bool) -> ProbeResult<u32> {
        if length == 0
            || value < 0x8000_0000
            || value
                .checked_add(length)
                .is_none_or(|end| end > 0x8180_0000)
            || (aligned && value & 3 != 0)
        {
            return Err(ProbeError::new(FailureCode::Pointer, self.predicate));
        }
        let last = value + length - 1;
        self.u8(value)?;
        self.u8(last)?;
        Ok(value)
    }

    fn effective_pointer(&self, value: u32, aligned: bool) -> ProbeResult<u32> {
        self.effective_pointer_span(value, 1, aligned)
    }

    fn effective_pointer_span(&self, value: u32, length: u32, aligned: bool) -> ProbeResult<u32> {
        if value == 0 || length == 0 || (aligned && value & 3 != 0) {
            return Err(ProbeError::new(FailureCode::Pointer, self.predicate));
        }
        let last = value
            .checked_add(length - 1)
            .ok_or_else(|| ProbeError::new(FailureCode::Pointer, self.predicate))?;
        self.u8(value)?;
        self.u8(last)?;
        Ok(value)
    }
}

fn add_address(address: u32, offset: u32, predicate: u64) -> ProbeResult<u32> {
    address
        .checked_add(offset)
        .ok_or_else(|| ProbeError::new(FailureCode::Pointer, predicate))
}

fn require(value: bool, code: FailureCode, predicate: u64) -> ProbeResult<()> {
    if value {
        Ok(())
    } else {
        Err(ProbeError::new(code, predicate))
    }
}

fn push_u8(out: &mut Vec<u8>, value: u8) {
    out.push(value);
}

fn push_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_i32(out: &mut Vec<u8>, value: i32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_f32(out: &mut Vec<u8>, value: f32) {
    out.extend_from_slice(&value.to_bits().to_le_bytes());
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn projection(
    state: TitleState,
    canonical: Vec<u8>,
    lifetime: Vec<u8>,
    input_witness: u32,
) -> Projection {
    Projection {
        hash: sha256(&canonical),
        lifetime_hash: sha256(&lifetime),
        guest_input_witness: input_witness,
        state,
    }
}

fn approximately_orthonormal(vectors: [Vec3; 3], tolerance: f32) -> bool {
    vectors.iter().all(|vector| {
        let length = vector.dot(*vector);
        (1.0 - tolerance..=1.0 + tolerance).contains(&length)
    }) && vectors[0].dot(vectors[1]).abs() <= tolerance
        && vectors[0].dot(vectors[2]).abs() <= tolerance
        && vectors[1].dot(vectors[2]).abs() <= tolerance
}

fn finite_distance_exceeds(left: Vec3, right: Vec3, threshold: f32) -> bool {
    let squared = left.distance_squared(right);
    squared.is_finite() && squared > threshold
}

fn positive_finite_magnitude(vector: Vec3) -> bool {
    let squared = vector.dot(vector);
    squared.is_finite() && squared > 0.0
}

fn determinant(vectors: [Vec3; 3]) -> f32 {
    let [a, b, c] = vectors;
    a.x * (b.y * c.z - b.z * c.y) - a.y * (b.x * c.z - b.z * c.x) + a.z * (b.x * c.y - b.y * c.x)
}

#[derive(Clone, Debug)]
struct WarioState {
    active_game: u32,
    runtime: u32,
    player: u32,
    result: i32,
}

fn project_wario<M: CheckedMem1>(memory: &M, stage: ProjectionStage) -> ProbeResult<Projection> {
    let predicate = match stage {
        ProjectionStage::Baseline => P_BASELINE_NEUTRAL,
        ProjectionStage::Receipt => P_RECEIPT_INPUT,
        ProjectionStage::Post => P_POST_ADVANCE,
    };
    let reader = Reader { memory, predicate };
    let active_game = reader.u32(0x8029_5ed0)?;
    let card_state = reader.s32(0x8029_58ac)?;
    require(
        active_game == 0x63 && card_state != 11 && card_state != 0x21,
        FailureCode::Predicate,
        P_MILESTONE,
    )?;
    let runtime = reader.mem1_pointer(reader.u32(0x802f_6860)?, 0x4b3fc, false)?;
    let buttons = reader.u16(add_address(runtime, 0x4b160, predicate)?)?;
    let player = reader.mem1_pointer(
        reader.u32(add_address(runtime, 0x4b178, predicate)?)?,
        0x1234,
        false,
    )?;
    let result = reader.s32(add_address(player, 0x1230, predicate)?)?;
    match stage {
        ProjectionStage::Baseline => require(
            buttons & 0x0100 == 0 && result == 0,
            FailureCode::Predicate,
            P_BASELINE_NEUTRAL,
        )?,
        ProjectionStage::Receipt => require(
            buttons & 0x0100 != 0 && result == 0,
            FailureCode::Predicate,
            P_RECEIPT_INPUT,
        )?,
        ProjectionStage::Post => require(
            buttons & 0x0100 == 0,
            FailureCode::Predicate,
            P_POST_ADVANCE,
        )?,
    }

    // Exported projection hashes describe reduced title semantics, not where the title happened
    // to allocate its objects. Pointer identity remains private in `lifetime_hash` and `state`.
    let mut canonical = Vec::with_capacity(16);
    push_u32(&mut canonical, active_game);
    push_i32(&mut canonical, card_state);
    push_u16(&mut canonical, buttons);
    push_i32(&mut canonical, result);
    let mut lifetime = Vec::with_capacity(12);
    push_u32(&mut lifetime, active_game);
    push_u32(&mut lifetime, runtime);
    push_u32(&mut lifetime, player);
    Ok(projection(
        TitleState::Wario(WarioState {
            active_game,
            runtime,
            player,
            result,
        }),
        canonical,
        lifetime,
        u32::from(buttons),
    ))
}

#[derive(Clone, Debug)]
struct LuigiState {
    player: u32,
    pad: u32,
    controller: u32,
    position: Vec3,
    heading: u16,
}

fn project_luigi<M: CheckedMem1>(memory: &M, stage: ProjectionStage) -> ProbeResult<Projection> {
    let predicate = match stage {
        ProjectionStage::Baseline => P_BASELINE_NEUTRAL,
        ProjectionStage::Receipt => P_RECEIPT_INPUT,
        ProjectionStage::Post => P_POST_ADVANCE,
    };
    let reader = Reader { memory, predicate };
    require(
        reader.u32(0x804d_80a0)? == 2
            && reader.u32(0x804d_80c4)? == 0
            && reader.u32(0x804d_80c8)? == 2
            && reader.u32(0x804d_8728)? == 2
            && reader.u32(0x803a_3cac)? == 0x0200_0102,
        FailureCode::Predicate,
        P_MILESTONE,
    )?;

    let event_count = reader.s16(0x804d_8374)?;
    require(
        (0..=4096).contains(&event_count),
        FailureCode::Range,
        P_MILESTONE,
    )?;
    if event_count != 0 {
        let event_base = reader.mem1_pointer(
            reader.u32(0x804d_8370)?,
            u32::from(event_count as u16) * 0x58,
            false,
        )?;
        for index in 0..u32::from(event_count as u16) {
            let slot = add_address(event_base, index * 0x58, P_MILESTONE)?;
            require(
                reader.u32(slot)? & 1 == 0,
                FailureCode::Predicate,
                P_MILESTONE,
            )?;
        }
    }

    let root = reader.mem1_pointer(reader.u32(0x804d_8c60)?, 12, false)?;
    let manager =
        reader.mem1_pointer(reader.u32(add_address(root, 8, predicate)?)?, 0xe0c, false)?;
    let handle = reader.u32(add_address(manager, 0xe08, predicate)?)?;
    let slot_offset = handle
        .checked_mul(4)
        .ok_or_else(|| ProbeError::new(FailureCode::Pointer, P_LIFETIME))?;
    let slot = add_address(0x803d_48a0, slot_offset, P_LIFETIME)?;
    require(slot <= 0x817f_fffc, FailureCode::Pointer, P_LIFETIME)?;
    let player = reader.mem1_pointer(reader.u32(slot)?, 0x1070, false)?;
    require(
        reader.u32(player)? == 0x8035_9d48
            && reader.u32(add_address(player, 0xb4, predicate)?)? == 0x0200_0102,
        FailureCode::Lifetime,
        P_LIFETIME,
    )?;
    let position = reader.vec3(0x803a_3ca0)?;
    let player_position = reader.vec3(add_address(player, 0x44, predicate)?)?;
    require(
        position.finite() && player_position.finite(),
        FailureCode::NonFinite,
        P_MILESTONE,
    )?;
    let heading = reader.u16(add_address(player, 0x88, predicate)?)?;

    let pad = reader.mem1_pointer(reader.u32(0x804d_8078)?, 0x77, false)?;
    let player_pad = reader.u32(add_address(player, 0x794, predicate)?)?;
    let controller = reader.mem1_pointer(
        reader.u32(add_address(player, 0x7d4, predicate)?)?,
        0x1e0,
        false,
    )?;
    require(
        player_pad == pad
            && reader.s16(add_address(player, 0xfc, predicate)?)? > 0
            && reader.u8(add_address(player, 0x1042, predicate)?)? == 0
            && reader.u8(add_address(player, 0x1058, predicate)?)? == 0
            && reader.f32(add_address(player, 0x105c, predicate)?)? <= 0.0
            && reader.f32(add_address(player, 0x106c, predicate)?)? == 0.0
            && reader.s16(add_address(pad, 0x74, predicate)?)? == 0
            && reader.u8(add_address(pad, 0x76, predicate)?)? == 0
            && reader.u32(add_address(controller, 0x1b0, predicate)?)? == pad,
        FailureCode::Predicate,
        P_MILESTONE,
    )?;

    let held = reader.u32(add_address(pad, 0x18, predicate)?)?;
    let trigger = reader.u32(add_address(pad, 0x1c, predicate)?)?;
    let stick_x = reader.f32(add_address(pad, 0x44, predicate)?)?;
    let stick_y = reader.f32(add_address(pad, 0x48, predicate)?)?;
    let stick_value = reader.f32(add_address(pad, 0x4c, predicate)?)?;
    let magnitude = reader.f32(add_address(controller, 0x1c0, predicate)?)?;
    let previous_magnitude = reader.f32(add_address(controller, 0x1dc, predicate)?)?;
    match stage {
        ProjectionStage::Baseline => require(
            held == 0
                && trigger == 0
                && stick_x == 0.0
                && stick_y == 0.0
                && stick_value == 0.0
                && magnitude == 0.0
                && previous_magnitude == 0.0,
            FailureCode::Predicate,
            P_BASELINE_NEUTRAL,
        )?,
        ProjectionStage::Receipt => require(
            held == 0x0100_0001
                && (-1.001..=-0.5).contains(&stick_x)
                && stick_y.abs() <= 0.125
                && (0.5..=1.001).contains(&stick_value)
                && (0.5..=1.001).contains(&magnitude),
            FailureCode::Predicate,
            P_RECEIPT_INPUT,
        )?,
        ProjectionStage::Post => {}
    }

    let mut canonical = Vec::with_capacity(84);
    position.push(&mut canonical);
    player_position.push(&mut canonical);
    push_u16(&mut canonical, heading);
    push_u32(&mut canonical, held);
    push_u32(&mut canonical, trigger);
    push_f32(&mut canonical, stick_x);
    push_f32(&mut canonical, stick_y);
    push_f32(&mut canonical, stick_value);
    push_f32(&mut canonical, magnitude);
    let mut lifetime = Vec::with_capacity(12);
    push_u32(&mut lifetime, player);
    push_u32(&mut lifetime, pad);
    push_u32(&mut lifetime, controller);
    Ok(projection(
        TitleState::Luigi(LuigiState {
            player,
            pad,
            controller,
            position,
            heading,
        }),
        canonical,
        lifetime,
        held,
    ))
}

#[derive(Clone, Debug)]
struct WindWakerState {
    player: u32,
    position: Vec3,
    heading: u16,
}

fn project_wind_waker<M: CheckedMem1>(
    memory: &M,
    stage: ProjectionStage,
) -> ProbeResult<Projection> {
    let predicate = match stage {
        ProjectionStage::Baseline => P_BASELINE_NEUTRAL,
        ProjectionStage::Receipt => P_RECEIPT_INPUT,
        ProjectionStage::Post => P_POST_ADVANCE,
    };
    let reader = Reader { memory, predicate };
    let stage_name = reader.bytes::<8>(0x803c_9d3c)?;
    require(
        stage_name.starts_with(b"sea\0")
            && reader.u8(0x803c_9d46)? == 44
            && reader.u8(0x803f_6a78)? == 44
            && reader.u8(0x803c_9ea2)? == 0
            && reader.u8(0x803f_7097)? == 0
            && reader.u8(0x803f_72b0)? == 0,
        FailureCode::Predicate,
        P_MILESTONE,
    )?;
    let player = reader.mem1_pointer(reader.u32(0x803c_a74c)?, 0x4c28, false)?;
    require(
        reader.u32(0x803c_a754)? == player
            && reader.u16(add_address(player, 8, predicate)?)? == 0x00a9
            && reader.u32(add_address(player, 0x10, predicate)?)? == 0x8038_fd8c
            && reader.u8(add_address(player, 0x0b, predicate)?)? == 0
            && reader.u8(add_address(player, 0x20a, predicate)?)? == 44,
        FailureCode::Lifetime,
        P_LIFETIME,
    )?;
    let position = reader.vec3(add_address(player, 0x1f8, predicate)?)?;
    let heading = reader.u16(add_address(player, 0x206, predicate)?)?;
    let stick_x = reader.f32(0x803a_4df0)?;
    let stick_y = reader.f32(0x803a_4df4)?;
    let stick_value = reader.f32(0x803a_4df8)?;
    let hold = reader.u16(0x803a_4e20)?;
    let trigger = reader.u16(0x803a_4e22)?;
    require(
        reader.u8(0x803a_4e24)? == 0,
        FailureCode::Predicate,
        P_MILESTONE,
    )?;
    match stage {
        ProjectionStage::Baseline => require(
            hold == 0 && trigger == 0 && stick_x == 0.0 && stick_y == 0.0 && stick_value == 0.0,
            FailureCode::Predicate,
            P_BASELINE_NEUTRAL,
        )?,
        ProjectionStage::Receipt => require(
            hold == 0x8000
                && (-1.001..=-0.5).contains(&stick_x)
                && stick_y.abs() <= 0.125
                && (0.5..=1.001).contains(&stick_value),
            FailureCode::Predicate,
            P_RECEIPT_INPUT,
        )?,
        ProjectionStage::Post => {}
    }
    let mut canonical = Vec::with_capacity(44);
    canonical.extend_from_slice(&stage_name);
    position.push(&mut canonical);
    push_u16(&mut canonical, heading);
    push_u16(&mut canonical, hold);
    push_u16(&mut canonical, trigger);
    push_f32(&mut canonical, stick_x);
    push_f32(&mut canonical, stick_y);
    push_f32(&mut canonical, stick_value);
    let mut lifetime = Vec::with_capacity(4);
    push_u32(&mut lifetime, player);
    Ok(projection(
        TitleState::WindWaker(WindWakerState {
            player,
            position,
            heading,
        }),
        canonical,
        lifetime,
        u32::from(hold),
    ))
}

#[derive(Clone, Debug)]
struct MeleeState {
    entity: u32,
    fighter: u32,
    character: i32,
    transformed_index: u8,
    sub_color: u8,
    stocks: u8,
    frame: u32,
    joystick_count: i32,
    motion: i32,
    position: Vec3,
    previous_position: Vec3,
    self_velocity_x: f32,
    position_delta_x: f32,
}

#[allow(
    clippy::float_cmp,
    reason = "the Melee projector authenticates exact guest copies and normalized endpoints"
)]
fn project_melee<M: CheckedMem1>(memory: &M, stage: ProjectionStage) -> ProbeResult<Projection> {
    const ROUTING: u32 = 0x8047_9d30;
    const MATCH: u32 = 0x8046_b6a0;
    const SLOT: u32 = 0x8045_3080;
    const SLOT_SIZE: u32 = 0xe90;
    const PAD: u32 = 0x804c_21cc;
    let predicate = match stage {
        ProjectionStage::Baseline => P_BASELINE_NEUTRAL,
        ProjectionStage::Receipt => P_RECEIPT_INPUT,
        ProjectionStage::Post => P_POST_ADVANCE,
    };
    let reader = Reader { memory, predicate };
    let scene = reader.mem1_pointer(reader.u32(0x804d_6720)?, 12, true)?;
    require(
        reader.u8(ROUTING)? == 2
            && reader.u8(ROUTING + 3)? == 2
            && reader.u8(ROUTING + 0x0c)? == 0
            && scene == 0x803d_d9dc
            && reader.u8(scene)? == 2
            && reader.u32(scene + 4)? == 0x8048_0530
            && reader.u32(scene + 8)? == 0x8047_9d98,
        FailureCode::Predicate,
        P_MILESTONE,
    )?;
    let frame = reader.u32(MATCH + 0x24)?;
    require(
        reader.u8(MATCH)? == 0
            && reader.u8(MATCH + 2)? == 0
            && reader.u8(MATCH + 4)? == 0
            && reader.u8(MATCH + 5)? == 1
            && reader.u8(MATCH + 6)? == 0
            && reader.u8(MATCH + 7)? == 0
            && reader.u8(MATCH + 8)? == 0
            && reader.u8(MATCH + 0x0e)? == 0
            && reader.u8(MATCH + 0x3a)? == 0
            && reader.u8(MATCH + 0x42)? == 0
            && reader.u8(0x8047_9d68)? == 0
            && frame > 0,
        FailureCode::Predicate,
        P_MILESTONE,
    )?;
    let mut has_opponent = false;
    for index in 1..=3_u32 {
        let opponent = SLOT + index * SLOT_SIZE;
        let state = reader.s32(opponent)?;
        let kind = reader.s32(opponent + 8)?;
        has_opponent |= state == 2 && (kind == 0 || kind == 1);
    }
    require(has_opponent, FailureCode::Predicate, P_MILESTONE)?;

    let slot_state = reader.s32(SLOT)?;
    let character = reader.s32(SLOT + 4)?;
    let slot_type = reader.s32(SLOT + 8)?;
    let transformed_index = reader.u8(SLOT + 0x0c)?;
    let sub_color = reader.u8(SLOT + 0x46)?;
    let player_id = reader.u8(SLOT + 0x48)?;
    let stocks = reader.u8(SLOT + 0x8e)?;
    require(
        slot_state == 2
            && (0..0x1a).contains(&character)
            && slot_type == 0
            && transformed_index < 2
            && sub_color < 5
            && player_id == 0
            && (1..0x80).contains(&stocks),
        FailureCode::Predicate,
        P_MILESTONE,
    )?;
    let transformed_offset = u32::from(transformed_index) * 4;
    let joystick_count = reader.s32(SLOT + 0xa0 + transformed_offset)?;
    require(joystick_count >= 0, FailureCode::Range, P_MILESTONE)?;
    let entity = reader.mem1_pointer(reader.u32(SLOT + 0xb0 + transformed_offset)?, 0x38, true)?;
    require(
        reader.u16(entity)? == 4
            && reader.u8(entity + 2)? == 8
            && reader.u8(entity + 4)? == 0
            && reader.u8(entity + 7)? == 4,
        FailureCode::Lifetime,
        P_LIFETIME,
    )?;
    let fighter = reader.mem1_pointer(reader.u32(entity + 0x2c)?, 0x23ec, true)?;
    let fighter_kind = reader.s32(fighter + 4)?;
    let motion = reader.s32(fighter + 0x10)?;
    require(
        reader.u32(fighter)? == entity
            && (0..0x21).contains(&fighter_kind)
            && reader.u8(fighter + 0x0c)? == 0
            && reader.u8(fighter + 0x618)? == player_id
            && reader.u8(fighter + 0x61a)? == sub_color
            && matches!(reader.s32(fighter + 0xe0)?, 0 | 1)
            && motion > 10,
        FailureCode::Lifetime,
        P_LIFETIME,
    )?;
    let position = reader.vec3(fighter + 0xb0)?;
    let previous_position = reader.vec3(fighter + 0xbc)?;
    let self_velocity_x = reader.f32(fighter + 0x80)?;
    let position_delta_x = reader.f32(fighter + 0xc8)?;
    let fighter_x = reader.f32(fighter + 0x620)?;
    let fighter_y = reader.f32(fighter + 0x624)?;
    let held_inputs = reader.u32(fighter + 0x65c)?;
    let pressed_inputs = reader.u32(fighter + 0x668)?;
    let pad_buttons = reader.u32(PAD)?;
    let pad_trigger = reader.u32(PAD + 8)?;
    let raw_x = reader.s8(PAD + 0x18)?;
    let raw_y = reader.s8(PAD + 0x19)?;
    let normalized_x = reader.f32(PAD + 0x20)?;
    let normalized_y = reader.f32(PAD + 0x24)?;
    require(
        reader.u8(PAD + 0x41)? == 0,
        FailureCode::Predicate,
        P_MILESTONE,
    )?;
    match stage {
        ProjectionStage::Baseline => require(
            motion == 14
                && pad_buttons == 0
                && pad_trigger == 0
                && raw_x == 0
                && raw_y == 0
                && normalized_x == 0.0
                && normalized_y == 0.0
                && fighter_x == 0.0
                && fighter_y == 0.0
                && held_inputs == 0
                && pressed_inputs == 0,
            FailureCode::Predicate,
            P_BASELINE_NEUTRAL,
        )?,
        ProjectionStage::Receipt => require(
            (14..=23).contains(&motion)
                && reader.s32(fighter + 0xe0)? == 0
                && pad_buttons == 0x0004_0001
                && pad_trigger == 0x0004_0001
                && raw_x == -80
                && raw_y == 0
                && normalized_x == -1.0
                && normalized_y == 0.0
                && fighter_x == normalized_x
                && fighter_y == normalized_y
                && held_inputs == 0x0004_0001
                && pressed_inputs == 0x0004_0001,
            FailureCode::Predicate,
            P_RECEIPT_INPUT,
        )?,
        ProjectionStage::Post => require(
            (15..=23).contains(&motion),
            FailureCode::Predicate,
            P_POST_ADVANCE,
        )?,
    }

    let mut canonical = Vec::with_capacity(120);
    push_i32(&mut canonical, character);
    push_u8(&mut canonical, transformed_index);
    push_u8(&mut canonical, sub_color);
    push_u8(&mut canonical, stocks);
    push_u32(&mut canonical, frame);
    push_i32(&mut canonical, joystick_count);
    push_i32(&mut canonical, motion);
    position.push(&mut canonical);
    previous_position.push(&mut canonical);
    push_f32(&mut canonical, self_velocity_x);
    push_f32(&mut canonical, position_delta_x);
    push_u32(&mut canonical, pad_buttons);
    push_u32(&mut canonical, held_inputs);
    let mut lifetime = Vec::with_capacity(24);
    push_u32(&mut lifetime, entity);
    push_u32(&mut lifetime, fighter);
    push_i32(&mut lifetime, character);
    push_u8(&mut lifetime, transformed_index);
    push_u8(&mut lifetime, sub_color);
    push_u8(&mut lifetime, stocks);
    push_i32(&mut lifetime, fighter_kind);
    Ok(projection(
        TitleState::Melee(MeleeState {
            entity,
            fighter,
            character,
            transformed_index,
            sub_color,
            stocks,
            frame,
            joystick_count,
            motion,
            position,
            previous_position,
            self_velocity_x,
            position_delta_x,
        }),
        canonical,
        lifetime,
        pad_buttons,
    ))
}

#[derive(Clone, Debug)]
struct FzeroState {
    reference: u32,
    racer: u32,
    entrant: u16,
    machine: u16,
    frame: u32,
    position: Vec3,
    world_velocity: Vec3,
}

#[allow(
    clippy::float_cmp,
    reason = "the F-Zero projector requires the title's duplicate steer field to be bit-exact"
)]
fn project_fzero<M: CheckedMem1>(memory: &M, stage: ProjectionStage) -> ProbeResult<Projection> {
    let predicate = match stage {
        ProjectionStage::Baseline => P_BASELINE_NEUTRAL,
        ProjectionStage::Receipt => P_RECEIPT_INPUT,
        ProjectionStage::Post => P_POST_ADVANCE,
    };
    let reader = Reader { memory, predicate };
    let reference = reader.mem1_pointer(reader.u32(0x8000_30c8)?, 1, true)?;
    let racer_pointer = add_address(reference, 0x0022_7878, P_LIFETIME)?;
    reader.mem1_pointer(racer_pointer, 4, true)?;
    let racer = reader.mem1_pointer(reader.u32(racer_pointer)?, 0x620, true)?;
    let general_state = reader.u32(racer)?;
    let entrant = reader.u16(racer + 4)?;
    let machine = reader.u16(racer + 6)?;
    let position = reader.vec3(racer + 0x07c)?;
    let previous_position = reader.vec3(racer + 0x088)?;
    let world_velocity = reader.vec3(racer + 0x094)?;
    let local_velocity = reader.vec3(racer + 0x0b8)?;
    let world_orientation = reader.vec3(racer + 0x0ec)?;
    let track_orientation = reader.vec3(racer + 0x1bc)?;
    let speed = reader.f32(racer + 0x17c)?;
    let energy = reader.f32(racer + 0x184)?;
    let checkpoint = reader.s32(racer + 0x1cc)?;
    let checkpoint_fraction = reader.f32(racer + 0x1d0)?;
    let steer_y = reader.f32(racer + 0x1f4)?;
    let strafe = reader.f32(racer + 0x1f8)?;
    let steer_x = reader.f32(racer + 0x1fc)?;
    let accelerator = reader.f32(racer + 0x200)?;
    let brake = reader.f32(racer + 0x204)?;
    let duplicate_x = reader.f32(racer + 0x20c)?;
    let restore_countdown = reader.u16(racer + 0x214)?;
    let controller_slot = reader.s8(racer + 0x474)?;
    let frame = reader.u32(racer + 0x47c)?;
    let crash_bit = reader.u8(racer + 0x4b3)?;
    let restore_complete = reader.u8(racer + 0x590)?;
    let breakdown = reader.u8(racer + 0x593)?;
    let post_restore = reader.u8(racer + 0x5d8)?;
    let crash_counter = reader.u32(racer + 0x194)?;
    require(
        [
            position,
            previous_position,
            world_velocity,
            local_velocity,
            world_orientation,
            track_orientation,
        ]
        .iter()
        .all(|vector| vector.finite())
            && speed.is_finite()
            && energy.is_finite()
            && checkpoint_fraction.is_finite()
            && accelerator.is_finite()
            && brake.is_finite()
            && (general_state & 0x0000_0080) == 0
            && (general_state & 0x0400_0000) == 0
            && controller_slot == 0
            && restore_complete == 1
            && steer_x == duplicate_x
            && crash_bit == 0
            && restore_countdown == 0
            && crash_counter == 0
            && breakdown == 0
            && post_restore == 0
            && positive_finite_magnitude(world_velocity)
            && finite_distance_exceeds(position, previous_position, 0.0),
        FailureCode::Predicate,
        P_MILESTONE,
    )?;
    match stage {
        ProjectionStage::Baseline => require(
            steer_y == 0.0 && strafe == 0.0 && steer_x == 0.0,
            FailureCode::Predicate,
            P_BASELINE_NEUTRAL,
        )?,
        ProjectionStage::Receipt => require(
            steer_y == 0.0
                && strafe == 0.0
                && (-1.0..=-0.5).contains(&steer_x)
                && positive_finite_magnitude(world_velocity),
            FailureCode::Predicate,
            P_RECEIPT_INPUT,
        )?,
        ProjectionStage::Post => {}
    }
    let mut canonical = Vec::with_capacity(120);
    push_u16(&mut canonical, entrant);
    push_u16(&mut canonical, machine);
    push_u32(&mut canonical, general_state);
    push_u32(&mut canonical, frame);
    position.push(&mut canonical);
    previous_position.push(&mut canonical);
    world_velocity.push(&mut canonical);
    push_f32(&mut canonical, speed);
    push_f32(&mut canonical, energy);
    push_i32(&mut canonical, checkpoint);
    push_f32(&mut canonical, checkpoint_fraction);
    push_f32(&mut canonical, steer_y);
    push_f32(&mut canonical, strafe);
    push_f32(&mut canonical, steer_x);
    push_f32(&mut canonical, duplicate_x);
    push_u32(&mut canonical, frame);
    let mut lifetime = Vec::with_capacity(16);
    push_u32(&mut lifetime, reference);
    push_u32(&mut lifetime, racer);
    push_u16(&mut lifetime, entrant);
    push_u16(&mut lifetime, machine);
    Ok(projection(
        TitleState::Fzero(FzeroState {
            reference,
            racer,
            entrant,
            machine,
            frame,
            position,
            world_velocity,
        }),
        canonical,
        lifetime,
        steer_x.to_bits(),
    ))
}

#[derive(Clone, Debug)]
struct MetroidState {
    world: u32,
    camera_manager: u32,
    first_person_camera: u32,
    player_state: u32,
    player_state_flags: u8,
    entity_flags: u8,
    camera_flags: u8,
    input_frame: u32,
    update_frame: u32,
    position: Vec3,
    forward: Vec3,
    up: Vec3,
}

fn project_metroid<M: CheckedMem1>(memory: &M, stage: ProjectionStage) -> ProbeResult<Projection> {
    const MANAGER: u32 = 0x8045_b208;
    const PLAYER: u32 = 0x8046_c9e8;
    const INPUT: u32 = MANAGER + 0xb54;
    let predicate = match stage {
        ProjectionStage::Baseline => P_BASELINE_NEUTRAL,
        ProjectionStage::Receipt => P_RECEIPT_INPUT,
        ProjectionStage::Post => P_POST_ADVANCE,
    };
    let reader = Reader { memory, predicate };
    require(
        reader.u32(0x8000_0000)? == 0x474d_3845
            && reader.u16(0x8000_0004)? == 0x3031
            && reader.u8(0x8000_0006)? == 0
            && reader.u8(0x8000_0007)? == 2,
        FailureCode::Predicate,
        P_IDENTITY,
    )?;
    reader.mem1_pointer(MANAGER, 0xb84, true)?;
    require(
        reader.u32(MANAGER + 0x84c)? == PLAYER,
        FailureCode::Lifetime,
        P_LIFETIME,
    )?;
    reader.mem1_pointer(PLAYER, 0xa48, true)?;
    let world = reader.mem1_pointer(reader.u32(MANAGER + 0x850)?, 0x6c, true)?;
    let camera_manager = reader.mem1_pointer(reader.u32(MANAGER + 0x870)?, 0x3cc, true)?;
    let player_state_ref = reader.mem1_pointer(reader.u32(MANAGER + 0x8b8)?, 8, true)?;
    let player_state = reader.mem1_pointer(reader.u32(player_state_ref)?, 0x198, true)?;
    let player_state_ref_count = reader.s32(player_state_ref + 4)?;
    let player_state_flags = reader.u8(player_state)?;
    require(
        player_state_ref_count > 0 && player_state_flags & 0x80 != 0,
        FailureCode::Predicate,
        P_MILESTONE,
    )?;
    let input_frame = reader.u32(MANAGER + 0x8d4)?;
    let update_frame = reader.u32(MANAGER + 0x8d8)?;
    require(
        reader.u32(world + 8)? == 0x158e_fe17
            && reader.s32(world + 0x68)? == 0
            && reader.s32(MANAGER + 0x8cc)? == 0
            && reader.u32(MANAGER + 0x904)? == 0
            && reader.u32(MANAGER + 0xb3c)? == 2,
        FailureCode::Predicate,
        P_MILESTONE,
    )?;

    let first_person_camera =
        reader.mem1_pointer(reader.u32(camera_manager + 0x88)?, 0x198, true)?;
    let current_camera_id = reader.u16(camera_manager)?;
    let first_person_id = reader.u16(first_person_camera + 8)?;
    let camera_flags = reader.u8(first_person_camera + 0x180)?;
    require(
        current_camera_id != 0xffff
            && current_camera_id == first_person_id
            && reader.u32(camera_manager + 8)? == 0
            && camera_flags & 0x40 == 0,
        FailureCode::Predicate,
        P_MILESTONE,
    )?;

    let entity_flags = reader.u8(PLAYER + 0x30)?;
    let movement_state = reader.u32(PLAYER + 0x268)?;
    let surface_restraint = reader.u32(PLAYER + 0x2bc)?;
    let frozen_timeout = reader.f32(PLAYER + 0x760)?;
    let input_flags = reader.u8(PLAYER + 0x9d6)?;
    require(
        reader.s32(PLAYER + 4)? == 0
            && reader.u16(PLAYER + 8)? != 0xffff
            && entity_flags & 0xf0 == 0x80
            && movement_state <= 4
            && surface_restraint <= 7
            && reader.u32(PLAYER + 0x304)? == 0
            && reader.u32(PLAYER + 0x308)? == 0
            && reader.u32(PLAYER + 0x314)? == 0
            && frozen_timeout <= 0.0
            && reader.u8(PLAYER + 0x770)? == 0
            && input_flags & 0x04 == 0
            && reader.f32(PLAYER + 0xa04)? == 0.0,
        FailureCode::Predicate,
        P_MILESTONE,
    )?;

    let right = reader.strided_vec3([PLAYER + 0x34, PLAYER + 0x44, PLAYER + 0x54])?;
    let forward = reader.strided_vec3([PLAYER + 0x38, PLAYER + 0x48, PLAYER + 0x58])?;
    let up = reader.strided_vec3([PLAYER + 0x3c, PLAYER + 0x4c, PLAYER + 0x5c])?;
    let position = reader.strided_vec3([PLAYER + 0x40, PLAYER + 0x50, PLAYER + 0x60])?;
    require(
        approximately_orthonormal([right, forward, up], 0.1),
        FailureCode::Predicate,
        P_MILESTONE,
    )?;
    let angular_velocity = reader.vec3(PLAYER + 0x154)?;
    let torque = reader.vec3(PLAYER + 0x184)?;

    let time = reader.f32(INPUT)?;
    let controller = reader.u32(INPUT + 4)?;
    let left_x = reader.f32(INPUT + 8)?;
    let left_y = reader.f32(INPUT + 0x0c)?;
    let right_x = reader.f32(INPUT + 0x10)?;
    let right_y = reader.f32(INPUT + 0x14)?;
    let left_trigger = reader.f32(INPUT + 0x18)?;
    let right_trigger = reader.f32(INPUT + 0x1c)?;
    let previous_left_trigger = reader.f32(INPUT + 0x24)?;
    let previous_right_trigger = reader.f32(INPUT + 0x28)?;
    let buttons1 = reader.u8(INPUT + 0x2c)?;
    let buttons2 = reader.u8(INPUT + 0x2d)?;
    let buttons3 = reader.u8(INPUT + 0x2e)?;
    require(
        (0.0..=1.0).contains(&time)
            && time > 0.0
            && controller == 0
            && [left_x, left_y, right_x, right_y]
                .iter()
                .all(|axis| (-1.0..=1.0).contains(axis))
            && [
                left_trigger,
                right_trigger,
                previous_left_trigger,
                previous_right_trigger,
            ]
            .iter()
            .all(|trigger| (0.0..=1.0).contains(trigger)),
        FailureCode::Range,
        P_MILESTONE,
    )?;
    match stage {
        ProjectionStage::Baseline => require(
            left_x == 0.0
                && left_y == 0.0
                && right_x == 0.0
                && right_y == 0.0
                && left_trigger == 0.0
                && right_trigger == 0.0
                && buttons1 == 0
                && buttons2 == 0
                && buttons3 == 0,
            FailureCode::Predicate,
            P_BASELINE_NEUTRAL,
        )?,
        ProjectionStage::Receipt => require(
            (-1.0..=-0.5).contains(&left_x)
                && left_y.abs() <= 0.125
                && right_x.abs() <= 0.125
                && right_y.abs() <= 0.125
                && left_trigger == 0.0
                && right_trigger == 0.0
                && previous_left_trigger == 0.0
                && previous_right_trigger == 0.0
                && buttons1 == 0
                && buttons2 == 0x20
                && matches!(buttons3, 0 | 0x02),
            FailureCode::Predicate,
            P_RECEIPT_INPUT,
        )?,
        ProjectionStage::Post => {}
    }

    let mut canonical = Vec::with_capacity(176);
    push_u8(&mut canonical, player_state_flags);
    push_u8(&mut canonical, entity_flags);
    push_u8(&mut canonical, camera_flags);
    push_u32(&mut canonical, input_frame);
    push_u32(&mut canonical, update_frame);
    right.push(&mut canonical);
    forward.push(&mut canonical);
    up.push(&mut canonical);
    position.push(&mut canonical);
    angular_velocity.push(&mut canonical);
    torque.push(&mut canonical);
    push_f32(&mut canonical, time);
    push_f32(&mut canonical, left_x);
    push_f32(&mut canonical, left_y);
    push_f32(&mut canonical, right_x);
    push_f32(&mut canonical, right_y);
    push_u8(&mut canonical, buttons1);
    push_u8(&mut canonical, buttons2);
    push_u8(&mut canonical, buttons3);
    let mut lifetime = Vec::with_capacity(32);
    push_u32(&mut lifetime, world);
    push_u32(&mut lifetime, camera_manager);
    push_u32(&mut lifetime, first_person_camera);
    push_u32(&mut lifetime, player_state);
    push_u8(&mut lifetime, player_state_flags);
    push_u8(&mut lifetime, entity_flags);
    push_u8(&mut lifetime, camera_flags);
    Ok(projection(
        TitleState::Metroid(MetroidState {
            world,
            camera_manager,
            first_person_camera,
            player_state,
            player_state_flags,
            entity_flags,
            camera_flags,
            input_frame,
            update_frame,
            position,
            forward,
            up,
        }),
        canonical,
        lifetime,
        u32::from(buttons2),
    ))
}

#[derive(Clone, Debug)]
struct RogueState {
    level: i32,
    sublevel: i32,
    craft: u32,
    handle: i32,
    config: u32,
    control: u32,
    response_460: f32,
    response_464: f32,
}

fn shaped_direction_coherent(source: f32, shaped: f32) -> bool {
    if source.abs() <= 0.02 {
        shaped.abs() <= 0.125
    } else {
        source.signum() == shaped.signum()
    }
}

fn project_rogue<M: CheckedMem1>(memory: &M, stage: ProjectionStage) -> ProbeResult<Projection> {
    const PLAYER_MANAGER: u32 = 0x7fde_fe14;
    const PAD: u32 = 0x7fde_e6e8;
    const NORMALIZED_PAD: u32 = 0x7fde_e718;
    const GLOBAL_AXES: u32 = 0x7fde_97e0;
    let predicate = match stage {
        ProjectionStage::Baseline => P_BASELINE_NEUTRAL,
        ProjectionStage::Receipt => P_RECEIPT_INPUT,
        ProjectionStage::Post => P_POST_ADVANCE,
    };
    let reader = Reader { memory, predicate };
    require(
        reader.u32(0x8000_0000)? == 0x4753_5745
            && reader.u16(0x8000_0004)? == 0x3634
            && reader.u8(0x8000_0006)? == 0
            && reader.u8(0x8000_0007)? == 0,
        FailureCode::Predicate,
        P_IDENTITY,
    )?;
    reader.effective_pointer(PLAYER_MANAGER, true)?;
    let craft = reader.effective_pointer_span(reader.u32(PLAYER_MANAGER)?, 0x468, true)?;
    let handle = reader.s32(PLAYER_MANAGER + 4)?;
    require(
        reader.s32(PLAYER_MANAGER + 8)? == 0
            && reader.u32(craft + 0x80)? == 0x7fdc_75b8
            && reader.u32(craft + 0x1a0)? == 0x7fdc_760c
            && reader.s32(craft + 0x370)? == 0,
        FailureCode::Lifetime,
        P_LIFETIME,
    )?;
    let config = reader.effective_pointer(reader.u32(craft + 0x37c)?, true)?;
    let control = reader.effective_pointer_span(reader.u32(craft + 0x380)?, 0x114, true)?;
    require(
        control == 0x7fdf_0fa4
            && reader.u32(control + 0x110)? == 0
            && reader.u32(control + 0x10c)? == 1,
        FailureCode::Lifetime,
        P_LIFETIME,
    )?;
    let shaped_x = reader.f32(control + 8)?;
    let shaped_y = reader.f32(control + 12)?;
    require(
        (-1.001..=1.001).contains(&shaped_x) && (-1.001..=1.001).contains(&shaped_y),
        FailureCode::Range,
        P_MILESTONE,
    )?;
    let response_45c = reader.f32(craft + 0x45c)?;
    let response_460 = reader.f32(craft + 0x460)?;
    let response_464 = reader.f32(craft + 0x464)?;
    let axes = [
        reader.vec3(craft + 0x84)?,
        reader.vec3(craft + 0x90)?,
        reader.vec3(craft + 0x9c)?,
    ];
    let position = reader.vec3(craft + 0xa8)?;
    let velocity = reader.vec3(craft + 0xb4)?;
    require(
        approximately_orthonormal(axes, 0.02)
            && determinant(axes) > 0.0
            && position.finite()
            && velocity.finite(),
        FailureCode::Predicate,
        P_MILESTONE,
    )?;

    reader.effective_pointer(PAD, false)?;
    let pad_buttons = reader.u16(PAD)?;
    let raw_x = reader.s8(PAD + 2)?;
    let raw_y = reader.s8(PAD + 3)?;
    require(
        reader.s8(PAD + 0x0a)? == 0,
        FailureCode::Predicate,
        P_MILESTONE,
    )?;
    let normalized_x = reader.f32(NORMALIZED_PAD)?;
    let normalized_y = reader.f32(NORMALIZED_PAD + 4)?;
    let global_x = reader.f32(GLOBAL_AXES)?;
    let global_y = reader.f32(GLOBAL_AXES + 4)?;
    let expected_x = f32::from(raw_x) / 72.0;
    let expected_y = f32::from(raw_y) / 72.0;
    require(
        (normalized_x - expected_x).abs() <= 0.000_001
            && (normalized_y - expected_y).abs() <= 0.000_001
            && (global_x - normalized_x).abs() <= 0.000_001
            && (global_y + normalized_y).abs() <= 0.000_001
            && shaped_direction_coherent(global_x, shaped_x)
            && shaped_direction_coherent(global_y, shaped_y),
        FailureCode::Predicate,
        P_MILESTONE,
    )?;
    match stage {
        ProjectionStage::Baseline => require(
            raw_x.unsigned_abs() <= 16
                && raw_y.unsigned_abs() <= 16
                && shaped_x.abs() <= 0.125
                && shaped_y.abs() <= 0.125,
            FailureCode::Predicate,
            P_BASELINE_NEUTRAL,
        )?,
        ProjectionStage::Receipt => require(
            (-128..=-36).contains(&raw_x)
                && raw_y.unsigned_abs() <= 16
                && normalized_x <= -0.5
                && global_x <= -0.5
                && (-1.001..=-0.5).contains(&shaped_x)
                && shaped_y.abs() <= 0.125,
            FailureCode::Predicate,
            P_RECEIPT_INPUT,
        )?,
        ProjectionStage::Post => {}
    }
    let level = reader.s32(0x7fde_822c)?;
    let sublevel = reader.s32(0x7fde_8230)?;
    let mut canonical = Vec::with_capacity(180);
    push_i32(&mut canonical, level);
    push_i32(&mut canonical, sublevel);
    push_i32(&mut canonical, handle);
    for axis in axes {
        axis.push(&mut canonical);
    }
    position.push(&mut canonical);
    velocity.push(&mut canonical);
    push_u16(&mut canonical, pad_buttons);
    push_u8(&mut canonical, raw_x.to_be_bytes()[0]);
    push_u8(&mut canonical, raw_y.to_be_bytes()[0]);
    push_f32(&mut canonical, normalized_x);
    push_f32(&mut canonical, normalized_y);
    push_f32(&mut canonical, global_x);
    push_f32(&mut canonical, global_y);
    push_f32(&mut canonical, shaped_x);
    push_f32(&mut canonical, shaped_y);
    push_f32(&mut canonical, response_45c);
    push_f32(&mut canonical, response_460);
    push_f32(&mut canonical, response_464);
    let mut lifetime = Vec::with_capacity(40);
    push_i32(&mut lifetime, level);
    push_i32(&mut lifetime, sublevel);
    push_u32(&mut lifetime, craft);
    push_i32(&mut lifetime, handle);
    push_u32(&mut lifetime, config);
    push_u32(&mut lifetime, control);
    push_u32(&mut lifetime, 0x7fdc_75b8);
    push_u32(&mut lifetime, 0x7fdc_760c);
    Ok(projection(
        TitleState::Rogue(RogueState {
            level,
            sublevel,
            craft,
            handle,
            config,
            control,
            response_460,
            response_464,
        }),
        canonical,
        lifetime,
        u32::from(pad_buttons),
    ))
}

fn project_title<M: CheckedMem1>(
    id: ProjectorId,
    memory: &M,
    stage: ProjectionStage,
) -> ProbeResult<Projection> {
    match id {
        ProjectorId::WarioWareRepellionA => project_wario(memory, stage),
        ProjectorId::LuigisMansionFoyerLeft => project_luigi(memory, stage),
        ProjectorId::WindWakerOutsetLeft => project_wind_waker(memory, stage),
        ProjectorId::MeleeActiveMatchLeft => project_melee(memory, stage),
        ProjectorId::FzeroActiveRaceSteer => project_fzero(memory, stage),
        ProjectorId::MetroidPrimeFrigateLeftTurn => project_metroid(memory, stage),
        ProjectorId::RogueLeaderXwingLeftResponse => project_rogue(memory, stage),
    }
}

#[allow(
    clippy::float_cmp,
    reason = "Melee's frozen projector requires exact unchanged orthogonal axes"
)]
fn validate_post(
    baseline: &Projection,
    receipt: &Projection,
    post: &Projection,
) -> ProbeResult<()> {
    if baseline.lifetime_hash != receipt.lifetime_hash
        || baseline.lifetime_hash != post.lifetime_hash
    {
        return Err(ProbeError::new(FailureCode::Lifetime, P_POST_LIFETIME));
    }
    match (&baseline.state, &receipt.state, &post.state) {
        (TitleState::Wario(a), TitleState::Wario(b), TitleState::Wario(c)) => {
            require(
                a.runtime == b.runtime
                    && a.runtime == c.runtime
                    && a.active_game == b.active_game
                    && a.active_game == c.active_game
                    && a.player == b.player
                    && a.player == c.player,
                FailureCode::Lifetime,
                P_POST_LIFETIME,
            )?;
            require(
                a.result == 0 && b.result == 0 && c.result != 0,
                FailureCode::Predicate,
                P_CAUSAL_DELTA,
            )?;
        }
        (TitleState::Luigi(a), TitleState::Luigi(b), TitleState::Luigi(c)) => {
            require(
                a.player == b.player
                    && a.player == c.player
                    && a.pad == b.pad
                    && a.pad == c.pad
                    && a.controller == b.controller
                    && a.controller == c.controller
                    && finite_distance_exceeds(c.position, a.position, 0.0001)
                    && finite_distance_exceeds(c.position, b.position, 0.0001),
                FailureCode::Predicate,
                P_CAUSAL_DELTA,
            )?;
            let _headings = (a.heading, b.heading, c.heading);
        }
        (TitleState::WindWaker(a), TitleState::WindWaker(b), TitleState::WindWaker(c)) => {
            let baseline_dx = c.position.x - a.position.x;
            let baseline_dz = c.position.z - a.position.z;
            let receipt_dx = c.position.x - b.position.x;
            let receipt_dz = c.position.z - b.position.z;
            let baseline_squared = baseline_dx.mul_add(baseline_dx, baseline_dz * baseline_dz);
            let receipt_squared = receipt_dx.mul_add(receipt_dx, receipt_dz * receipt_dz);
            require(
                a.player == b.player
                    && a.player == c.player
                    && baseline_squared.is_finite()
                    && baseline_squared > 0.0001
                    && receipt_squared.is_finite()
                    && receipt_squared > 0.0001,
                FailureCode::Predicate,
                P_CAUSAL_DELTA,
            )?;
            let _headings = (a.heading, b.heading, c.heading);
        }
        (TitleState::Melee(a), TitleState::Melee(b), TitleState::Melee(c)) => {
            let from_baseline = a.position.x - c.position.x;
            let from_receipt = b.position.x - c.position.x;
            let terminal = c.previous_position.x - c.position.x;
            let from_baseline_squared = from_baseline * from_baseline;
            let from_receipt_squared = from_receipt * from_receipt;
            let terminal_squared = terminal * terminal;
            require(
                a.entity == b.entity
                    && a.entity == c.entity
                    && a.fighter == b.fighter
                    && a.fighter == c.fighter
                    && a.character == c.character
                    && a.transformed_index == c.transformed_index
                    && a.sub_color == c.sub_color
                    && a.stocks == c.stocks
                    && b.frame >= a.frame
                    && c.frame > b.frame
                    && b.joystick_count >= a.joystick_count
                    && a.joystick_count.checked_add(1) == Some(c.joystick_count)
                    && (15..=23).contains(&c.motion)
                    && b.position.y == a.position.y
                    && b.position.z == a.position.z
                    && c.position.y == b.position.y
                    && c.position.z == b.position.z
                    && c.previous_position.y == c.position.y
                    && c.previous_position.z == c.position.z
                    && from_baseline.is_finite()
                    && from_receipt.is_finite()
                    && terminal.is_finite()
                    && from_baseline_squared.is_finite()
                    && from_receipt_squared.is_finite()
                    && terminal_squared.is_finite()
                    && from_baseline > 0.0
                    && from_baseline_squared > 0.0001
                    && from_receipt > 0.0
                    && from_receipt_squared > 0.0001
                    && terminal > 0.0
                    && terminal_squared > 0.0001
                    && c.self_velocity_x < 0.0
                    && c.position_delta_x < 0.0,
                FailureCode::Predicate,
                P_CAUSAL_DELTA,
            )?;
        }
        (TitleState::Fzero(a), TitleState::Fzero(b), TitleState::Fzero(c)) => {
            require(
                a.reference == b.reference
                    && a.reference == c.reference
                    && a.racer == b.racer
                    && a.racer == c.racer
                    && a.entrant == b.entrant
                    && a.entrant == c.entrant
                    && a.machine == b.machine
                    && a.machine == c.machine
                    && b.frame >= a.frame
                    && c.frame > b.frame
                    && positive_finite_magnitude(b.world_velocity)
                    && finite_distance_exceeds(c.position, a.position, 0.0001)
                    && finite_distance_exceeds(c.position, b.position, 0.0001),
                FailureCode::Predicate,
                P_CAUSAL_DELTA,
            )?;
        }
        (TitleState::Metroid(a), TitleState::Metroid(b), TitleState::Metroid(c)) => {
            require(
                a.world == b.world
                    && a.world == c.world
                    && a.camera_manager == b.camera_manager
                    && a.camera_manager == c.camera_manager
                    && a.first_person_camera == b.first_person_camera
                    && a.first_person_camera == c.first_person_camera
                    && a.player_state == b.player_state
                    && a.player_state == c.player_state
                    && a.player_state_flags == b.player_state_flags
                    && a.player_state_flags == c.player_state_flags
                    && a.entity_flags == b.entity_flags
                    && a.entity_flags == c.entity_flags
                    && a.camera_flags == b.camera_flags
                    && a.camera_flags == c.camera_flags
                    && b.input_frame >= a.input_frame
                    && b.update_frame >= a.update_frame
                    && c.input_frame >= b.input_frame
                    && c.update_frame > b.update_frame
                    && c.update_frame > a.update_frame
                    && finite_distance_exceeds(c.forward, a.forward, 0.000_000_000_001),
                FailureCode::Predicate,
                P_CAUSAL_DELTA,
            )?;
            let _stable_vectors = (a.position, b.position, c.position, a.up, b.up, c.up);
        }
        (TitleState::Rogue(a), TitleState::Rogue(b), TitleState::Rogue(c)) => {
            let response_460_delta = b.response_460 - a.response_460;
            let response_464_delta = b.response_464 - a.response_464;
            require(
                a.level == b.level
                    && a.level == c.level
                    && a.sublevel == b.sublevel
                    && a.sublevel == c.sublevel
                    && a.craft == b.craft
                    && a.craft == c.craft
                    && a.handle == b.handle
                    && a.handle == c.handle
                    && a.config == b.config
                    && a.config == c.config
                    && a.control == b.control
                    && a.control == c.control
                    && response_460_delta.is_finite()
                    && response_464_delta.is_finite()
                    && (response_460_delta.abs() > 0.0001 || response_464_delta.abs() > 0.0001),
                FailureCode::Predicate,
                P_CAUSAL_DELTA,
            )?;
        }
        _ => {
            return Err(ProbeError::new(
                FailureCode::UnsupportedIdentity,
                P_IDENTITY,
            ));
        }
    }
    Ok(())
}

fn validate_presentation(identity: PresentationIdentity) -> Result<(), FailureCode> {
    if identity.status != RenderPresentationStatus::Presented
        || identity.render_sequence == 0
        || identity.presentation_serial == 0
        || identity.xfb_generation == 0
        || identity.pair_epoch == 0
        || identity.output_width == 0
        || identity.output_width > 2048
        || identity.output_height == 0
        || identity.output_height > 2048
        || identity.selected_row >= identity.output_height
    {
        return Err(FailureCode::Presentation);
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub struct GameFidelityRecord {
    identity: AuthenticatedDiscIdentity,
    projector: ProjectorId,
    phase: ProbePhase,
    failure: FailureCode,
    required: u64,
    passed: u64,
    failed: u64,
    machine_epoch: u64,
    arm: Option<ArmObservation>,
    publication: Option<SiPublication>,
    receipt: Option<GuestReceipt>,
    post_cycle: u64,
    later_presentation: Option<PresentationObservation>,
    /// Title-specific guest input: digital bits where native, otherwise the exact reduced analog
    /// bit pattern (F-Zero uses steer-X). It is always read from guest state, never synthesized.
    guest_input_witness: u32,
    baseline_hash: [u8; 32],
    receipt_hash: [u8; 32],
    post_hash: [u8; 32],
    publication_packet_hash: [u8; 32],
}

#[cfg_attr(
    test,
    allow(dead_code, reason = "exercised by path-based projector contracts")
)]
impl GameFidelityRecord {
    pub const fn phase(&self) -> ProbePhase {
        self.phase
    }

    #[cfg(test)]
    pub const fn failure(&self) -> FailureCode {
        self.failure
    }

    #[cfg(test)]
    pub const fn projector(&self) -> ProjectorId {
        self.projector
    }

    #[cfg(test)]
    pub const fn required_predicates(&self) -> u64 {
        self.required
    }

    #[cfg(test)]
    pub const fn passed_predicates(&self) -> u64 {
        self.passed
    }

    #[cfg(test)]
    pub const fn failed_predicates(&self) -> u64 {
        self.failed
    }

    pub fn to_bytes(&self) -> [u8; GAME_FIDELITY_RECORD_BYTES] {
        let mut words = [0_u32; GAME_FIDELITY_RECORD_WORDS];
        words[0] = RECORD_MAGIC;
        words[1] = GAME_FIDELITY_RECORD_VERSION;
        words[2] = GAME_FIDELITY_RECORD_BYTES as u32;
        words[3] = self.phase as u32;
        words[4] = match self.phase {
            ProbePhase::Accepted => 1,
            ProbePhase::Failed => 2,
            _ => 0,
        };
        words[5] = self.failure as u32;
        words[6] = self.projector as u32;
        words[8] = u32::from_le_bytes([
            self.identity.id[0],
            self.identity.id[1],
            self.identity.id[2],
            self.identity.id[3],
        ]);
        words[9] = u32::from(self.identity.id[4])
            | (u32::from(self.identity.id[5]) << 8)
            | (u32::from(self.identity.revision) << 16);
        put_u64(&mut words, 10, self.required);
        put_u64(&mut words, 12, self.passed);
        put_u64(&mut words, 14, self.failed);
        put_u64(&mut words, 16, self.machine_epoch);
        if let Some(arm) = self.arm {
            put_u64(&mut words, 18, arm.cycle);
            put_u64(&mut words, 20, arm.presentation_cycle);
            put_u64(&mut words, 32, arm.controller_applied_sequence);
            put_u64(&mut words, 38, arm.presentation.presentation_serial);
            words[42] = arm.controller_poll_index;
            put_presentation(&mut words, 80, arm.presentation);
        }
        if let Some(publication) = self.publication {
            put_u64(&mut words, 22, publication.scheduled_cycle);
            put_u64(&mut words, 24, publication.observed_cycle);
            put_u64(&mut words, 34, publication.sequence);
            words[43] = publication.poll_index;
            words[45] = publication.source as u32;
            words[46] = publication.buttons;
        }
        if let Some(receipt) = self.receipt {
            put_u64(&mut words, 26, receipt.cycle);
            put_u64(&mut words, 36, receipt.applied_sequence);
            words[44] = receipt.poll_index;
        }
        put_u64(&mut words, 28, self.post_cycle);
        if let Some(later) = self.later_presentation {
            put_u64(&mut words, 30, later.cycle);
            put_u64(&mut words, 40, later.presentation.presentation_serial);
            put_presentation(&mut words, 88, later.presentation);
        }
        words[47] = self.guest_input_witness;
        put_hash(&mut words, 48, self.baseline_hash);
        put_hash(&mut words, 56, self.receipt_hash);
        put_hash(&mut words, 64, self.post_hash);
        put_hash(&mut words, 72, self.publication_packet_hash);

        let mut bytes = [0_u8; GAME_FIDELITY_RECORD_BYTES];
        for (chunk, word) in bytes.chunks_exact_mut(4).zip(words) {
            chunk.copy_from_slice(&word.to_le_bytes());
        }
        bytes
    }
}

fn put_u64(words: &mut [u32; GAME_FIDELITY_RECORD_WORDS], index: usize, value: u64) {
    words[index] = value as u32;
    words[index + 1] = (value >> 32) as u32;
}

fn put_hash(words: &mut [u32; GAME_FIDELITY_RECORD_WORDS], index: usize, hash: [u8; 32]) {
    for offset in 0..8 {
        let byte = offset * 4;
        words[index + offset] =
            u32::from_le_bytes([hash[byte], hash[byte + 1], hash[byte + 2], hash[byte + 3]]);
    }
}

fn put_presentation(
    words: &mut [u32; GAME_FIDELITY_RECORD_WORDS],
    index: usize,
    identity: PresentationIdentity,
) {
    put_u64(words, index, identity.render_sequence);
    words[index + 2] = identity.xfb_generation;
    words[index + 3] = identity.pair_epoch;
    words[index + 4] = identity.selected_row;
    words[index + 5] =
        (identity.mode as u32) | ((identity.parity as u32) << 8) | ((identity.status as u32) << 16);
    words[index + 6] = identity.output_width;
    words[index + 7] = identity.output_height;
}

#[derive(Clone, Debug)]
pub struct GameFidelityProbe {
    spec: ProjectorSpec,
    machine_epoch: u64,
    phase: ProbePhase,
    failure: FailureCode,
    passed: u64,
    failed: u64,
    arm: Option<ArmObservation>,
    publication: Option<SiPublication>,
    receipt: Option<GuestReceipt>,
    post_cycle: u64,
    later_presentation: Option<PresentationObservation>,
    baseline: Option<Projection>,
    received: Option<Projection>,
    post: Option<Projection>,
    publication_packet_hash: [u8; 32],
}

#[cfg_attr(
    test,
    allow(dead_code, reason = "exercised by path-based projector contracts")
)]
impl GameFidelityProbe {
    pub fn select(
        identity: AuthenticatedDiscIdentity,
        machine_epoch: u64,
    ) -> Result<Self, FailureCode> {
        let spec = PROJECTORS
            .iter()
            .copied()
            .find(|spec| spec.identity == identity)
            .ok_or(FailureCode::UnsupportedIdentity)?;
        if machine_epoch == 0 {
            return Err(FailureCode::Range);
        }
        Ok(Self {
            spec,
            machine_epoch,
            phase: ProbePhase::Unarmed,
            failure: FailureCode::None,
            passed: 0,
            failed: 0,
            arm: None,
            publication: None,
            receipt: None,
            post_cycle: 0,
            later_presentation: None,
            baseline: None,
            received: None,
            post: None,
            publication_packet_hash: [0; 32],
        })
    }

    #[cfg(test)]
    pub const fn projector(&self) -> ProjectorId {
        self.spec.id
    }

    pub(crate) const fn requested_buttons(&self) -> u32 {
        self.spec.expected_input.buttons as u32
    }

    /// Exact Rust-authored normalized controller state for the selected projector.
    ///
    /// The browser transports this state through the ordinary SI publication ABI. It must not
    /// reconstruct analog lanes from button bits or select a title-specific input policy.
    pub(crate) const fn requested_controller_state(&self) -> ControllerInputState {
        self.spec.expected_input
    }

    /// Marks a failure detected by the Rust machine integration rather than a title projection.
    /// The first failure remains authoritative, matching failures produced by phase methods.
    pub(crate) fn fail_closed(&mut self, code: FailureCode, predicate: u64) {
        if self.phase != ProbePhase::Failed {
            self.phase = ProbePhase::Failed;
            self.failure = code;
            self.failed |= predicate;
        }
    }

    /// Whether a failed clone represents a title transition that simply has not happened yet.
    /// Memory, pointer, range, non-finite, identity, and lifetime failures never qualify here.
    pub(crate) fn is_retryable_transition_failure(&self, from: ProbePhase) -> bool {
        if self.phase != ProbePhase::Failed || self.failure != FailureCode::Predicate {
            return false;
        }
        let retryable = match from {
            ProbePhase::Published => P_RECEIPT_INPUT,
            ProbePhase::Received => P_POST_ADVANCE | P_CAUSAL_DELTA,
            _ => 0,
        };
        self.failed != 0 && self.failed & !retryable == 0
    }

    pub fn arm<M: CheckedMem1>(
        &mut self,
        memory: &M,
        observation: ArmObservation,
    ) -> Result<(), FailureCode> {
        self.require_phase(ProbePhase::Unarmed)?;
        if observation.cycle == 0
            || observation.presentation_cycle > observation.cycle
            || validate_presentation(observation.presentation).is_err()
        {
            return self.poison(FailureCode::Presentation, P_PRESENTATION);
        }
        let baseline = match project_title(self.spec.id, memory, ProjectionStage::Baseline) {
            Ok(projection) => projection,
            Err(error) => return self.poison(error.code, error.predicate),
        };
        self.arm = Some(observation);
        self.baseline = Some(baseline);
        self.passed |= P_IDENTITY | P_MILESTONE | P_LIFETIME | P_BASELINE_NEUTRAL;
        self.phase = ProbePhase::Baseline;
        Ok(())
    }

    pub fn observe_publication(&mut self, publication: SiPublication) -> Result<(), FailureCode> {
        self.require_phase(ProbePhase::Baseline)?;
        let Some(arm) = self.arm else {
            return self.poison(FailureCode::WrongPhase, P_PUBLICATION);
        };
        if publication.buttons != u32::from(self.spec.expected_input.buttons)
            || publication.state != self.spec.expected_input
            || publication.buttons != u32::from(publication.state.buttons)
            || publication.packet != publication.state.packet(publication.mode)
        {
            return self.poison(FailureCode::Predicate, P_PUBLICATION);
        }
        let packet_buttons = u16::from_be_bytes([publication.packet[0], publication.packet[1]]);
        let Ok(authored_buttons) = u16::try_from(publication.buttons) else {
            return self.poison(FailureCode::Range, P_PUBLICATION);
        };
        if packet_buttons != authored_buttons | lazuli::system::si::PAD_USE_ORIGIN {
            return self.poison(FailureCode::Predicate, P_PUBLICATION);
        }
        if publication.scheduled_cycle < arm.cycle
            || publication.scheduled_cycle > publication.observed_cycle
        {
            return self.poison(FailureCode::Chronology, P_PUBLICATION);
        }
        if publication.poll_index <= arm.controller_poll_index
            || publication.sequence <= arm.controller_applied_sequence
        {
            return self.poison(FailureCode::Sequence, P_PUBLICATION);
        }
        self.publication_packet_hash = sha256(&publication.packet);
        self.publication = Some(publication);
        self.passed |= P_PUBLICATION;
        self.phase = ProbePhase::Published;
        Ok(())
    }

    /// Returns whether a post-receipt title sample can be strictly later at `cycle`.
    ///
    /// An equal-cycle dispatcher boundary is valid but cannot yet prove forward progress. A true
    /// regression remains an evidence failure.
    pub(crate) fn post_observation_ready(&self, cycle: u64) -> Result<bool, FailureCode> {
        if self.phase != ProbePhase::Received {
            return Err(FailureCode::WrongPhase);
        }
        let receipt = self.receipt.ok_or(FailureCode::WrongPhase)?;
        if cycle < receipt.cycle {
            return Err(FailureCode::Chronology);
        }
        Ok(cycle > receipt.cycle)
    }

    /// Returns whether a Presented completion is a distinct, strictly later frame.
    ///
    /// Re-presenting the baseline XFB is valid VI behavior and is retained as not-ready. A true
    /// chronology or authenticated-identity regression remains an evidence failure.
    pub(crate) fn presentation_observation_ready(
        &self,
        observation: PresentationObservation,
    ) -> Result<bool, FailureCode> {
        if self.phase != ProbePhase::Posted || self.post_cycle == 0 {
            return Err(FailureCode::WrongPhase);
        }
        if validate_presentation(observation.presentation).is_err() {
            return Err(FailureCode::Presentation);
        }
        let baseline = self.arm.ok_or(FailureCode::WrongPhase)?;
        if observation.cycle < self.post_cycle {
            return Err(FailureCode::Chronology);
        }
        if observation.presentation.presentation_serial < baseline.presentation.presentation_serial
            || observation.presentation.render_sequence < baseline.presentation.render_sequence
            || observation.presentation.pair_epoch < baseline.presentation.pair_epoch
            || observation.presentation.output_width != baseline.presentation.output_width
            || observation.presentation.output_height != baseline.presentation.output_height
            || observation.presentation.mode != baseline.presentation.mode
        {
            return Err(FailureCode::Presentation);
        }
        Ok(observation.cycle > self.post_cycle
            && observation.presentation.presentation_serial
                > baseline.presentation.presentation_serial
            && observation.presentation.render_sequence > baseline.presentation.render_sequence
            && observation.presentation.xfb_generation > baseline.presentation.xfb_generation
            && observation.presentation.pair_epoch > baseline.presentation.pair_epoch)
    }

    pub fn observe_guest_receipt<M: CheckedMem1>(
        &mut self,
        memory: &M,
        receipt: GuestReceipt,
    ) -> Result<(), FailureCode> {
        self.require_phase(ProbePhase::Published)?;
        let Some(publication) = self.publication else {
            return self.poison(FailureCode::WrongPhase, P_RECEIPT_SEQUENCE);
        };
        if receipt.cycle < publication.observed_cycle {
            return self.poison(FailureCode::Chronology, P_RECEIPT_SEQUENCE);
        }
        if receipt.applied_sequence != publication.sequence
            || receipt.poll_index < publication.poll_index
        {
            return self.poison(FailureCode::Sequence, P_RECEIPT_SEQUENCE);
        }
        let projection = match project_title(self.spec.id, memory, ProjectionStage::Receipt) {
            Ok(projection) => projection,
            Err(error) => return self.poison(error.code, error.predicate),
        };
        if self
            .baseline
            .as_ref()
            .is_none_or(|baseline| baseline.lifetime_hash != projection.lifetime_hash)
        {
            return self.poison(FailureCode::Lifetime, P_LIFETIME);
        }
        self.receipt = Some(receipt);
        self.received = Some(projection);
        self.passed |= P_RECEIPT_SEQUENCE | P_RECEIPT_INPUT;
        self.phase = ProbePhase::Received;
        Ok(())
    }

    pub fn observe_post<M: CheckedMem1>(
        &mut self,
        memory: &M,
        cycle: u64,
    ) -> Result<(), FailureCode> {
        self.require_phase(ProbePhase::Received)?;
        let Some(receipt) = self.receipt else {
            return self.poison(FailureCode::WrongPhase, P_POST_ADVANCE);
        };
        if cycle <= receipt.cycle {
            return self.poison(FailureCode::Chronology, P_POST_ADVANCE);
        }
        let post = match project_title(self.spec.id, memory, ProjectionStage::Post) {
            Ok(projection) => projection,
            Err(error) => return self.poison(error.code, error.predicate),
        };
        let Some(baseline) = self.baseline.as_ref() else {
            return self.poison(FailureCode::WrongPhase, P_POST_LIFETIME);
        };
        let Some(received) = self.received.as_ref() else {
            return self.poison(FailureCode::WrongPhase, P_POST_LIFETIME);
        };
        let validation = validate_post(baseline, received, &post);
        if let Err(error) = validation {
            return self.poison(error.code, error.predicate);
        }
        self.post_cycle = cycle;
        self.post = Some(post);
        self.passed |= P_POST_LIFETIME | P_POST_ADVANCE | P_CAUSAL_DELTA;
        self.phase = ProbePhase::Posted;
        Ok(())
    }

    pub fn observe_presentation(
        &mut self,
        observation: PresentationObservation,
    ) -> Result<(), FailureCode> {
        self.require_phase(ProbePhase::Posted)?;
        if validate_presentation(observation.presentation).is_err() {
            return self.poison(FailureCode::Presentation, P_PRESENTATION);
        }
        let Some(baseline) = self.arm else {
            return self.poison(FailureCode::WrongPhase, P_PRESENTATION);
        };
        let Some(receipt) = self.receipt else {
            return self.poison(FailureCode::WrongPhase, P_PRESENTATION);
        };
        if observation.cycle <= self.post_cycle
            || observation.cycle < receipt.cycle
            || observation.presentation.presentation_serial
                <= baseline.presentation.presentation_serial
            || observation.presentation.render_sequence <= baseline.presentation.render_sequence
            || observation.presentation.xfb_generation <= baseline.presentation.xfb_generation
            || observation.presentation.pair_epoch <= baseline.presentation.pair_epoch
            || observation.presentation.output_width != baseline.presentation.output_width
            || observation.presentation.output_height != baseline.presentation.output_height
            || observation.presentation.mode != baseline.presentation.mode
        {
            return self.poison(FailureCode::Presentation, P_PRESENTATION);
        }
        self.later_presentation = Some(observation);
        self.passed |= P_PRESENTATION;
        if self.passed & self.spec.required != self.spec.required {
            return self.poison(FailureCode::Predicate, self.spec.required & !self.passed);
        }
        self.phase = ProbePhase::Accepted;
        Ok(())
    }

    pub fn record(&self) -> GameFidelityRecord {
        GameFidelityRecord {
            identity: self.spec.identity,
            projector: self.spec.id,
            phase: self.phase,
            failure: self.failure,
            required: self.spec.required,
            passed: self.passed,
            failed: self.failed,
            machine_epoch: self.machine_epoch,
            arm: self.arm,
            publication: self.publication,
            receipt: self.receipt,
            post_cycle: self.post_cycle,
            later_presentation: self.later_presentation,
            guest_input_witness: self
                .received
                .as_ref()
                .map_or(0, |projection| projection.guest_input_witness),
            baseline_hash: self
                .baseline
                .as_ref()
                .map_or([0; 32], |projection| projection.hash),
            receipt_hash: self
                .received
                .as_ref()
                .map_or([0; 32], |projection| projection.hash),
            post_hash: self
                .post
                .as_ref()
                .map_or([0; 32], |projection| projection.hash),
            publication_packet_hash: self.publication_packet_hash,
        }
    }

    pub fn record_bytes(&self) -> [u8; GAME_FIDELITY_RECORD_BYTES] {
        self.record().to_bytes()
    }

    fn require_phase(&mut self, expected: ProbePhase) -> Result<(), FailureCode> {
        if self.phase == expected {
            Ok(())
        } else if self.phase == ProbePhase::Failed {
            Err(self.failure)
        } else {
            self.poison(FailureCode::WrongPhase, self.spec.required & !self.passed)
        }
    }

    fn poison(&mut self, code: FailureCode, predicate: u64) -> Result<(), FailureCode> {
        if self.phase != ProbePhase::Failed {
            self.phase = ProbePhase::Failed;
            self.failure = code;
            self.failed |= predicate;
        }
        Err(self.failure)
    }
}
