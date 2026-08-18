#![cfg(feature = "game-fidelity-probes")]

#[allow(
    dead_code,
    reason = "the path test exercises the projector core without its machine owner"
)]
#[path = "../src/game_fidelity.rs"]
mod game_fidelity;

use std::collections::BTreeMap;

use game_fidelity::{
    ArmObservation, AuthenticatedDiscIdentity, CheckedMem1, FailureCode,
    GAME_FIDELITY_RECORD_BYTES, GAME_FIDELITY_RECORD_VERSION, GameFidelityProbe, GuestReceipt,
    Mem1ReadFault, PresentationIdentity, PresentationObservation, ProbePhase, ProjectorId,
    PublicationSource, RenderPresentationStatus, SiPublication, ViFieldParity, ViPresentationMode,
};
use lazuli::system::si::ControllerInputState;

const IDENTITIES: [([u8; 6], u8, ProjectorId); 7] = [
    (*b"GZWE01", 0, ProjectorId::WarioWareRepellionA),
    (*b"GLME01", 0, ProjectorId::LuigisMansionFoyerLeft),
    (*b"GZLE01", 0, ProjectorId::WindWakerOutsetLeft),
    (*b"GALE01", 2, ProjectorId::MeleeActiveMatchLeft),
    (*b"GFZE01", 0, ProjectorId::FzeroActiveRaceSteer),
    (*b"GM8E01", 2, ProjectorId::MetroidPrimeFrigateLeftTurn),
    (*b"GSWE64", 0, ProjectorId::RogueLeaderXwingLeftResponse),
];

#[test]
fn exact_authenticated_identity_is_the_only_projector_selector() {
    for (id, revision, expected) in IDENTITIES {
        let probe = GameFidelityProbe::select(AuthenticatedDiscIdentity { id, revision }, 1)
            .expect("exact identity should select a projector");
        assert_eq!(probe.projector(), expected);
        assert_eq!(probe.record().projector(), expected);
        assert!(!expected.oracle_id().is_empty());

        let drifted = AuthenticatedDiscIdentity {
            id,
            revision: revision.wrapping_add(1),
        };
        assert_eq!(
            GameFidelityProbe::select(drifted, 1).unwrap_err(),
            FailureCode::UnsupportedIdentity,
        );
    }
    assert_eq!(
        GameFidelityProbe::select(
            AuthenticatedDiscIdentity {
                id: *b"GMBE8P",
                revision: 0,
            },
            1,
        )
        .unwrap_err(),
        FailureCode::UnsupportedIdentity,
    );
    assert_eq!(
        GameFidelityProbe::select(
            AuthenticatedDiscIdentity {
                id: *b"GZWE01",
                revision: 0,
            },
            0,
        )
        .unwrap_err(),
        FailureCode::Range,
    );
}

#[test]
fn rust_authors_the_exact_generic_controller_witness_for_all_seven_projectors() {
    let wario = ControllerInputState {
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
    let left = ControllerInputState {
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
    for (index, (id, revision, _projector)) in IDENTITIES.into_iter().enumerate() {
        let probe = GameFidelityProbe::select(AuthenticatedDiscIdentity { id, revision }, 1)
            .expect("exact identity should select a controller witness");
        assert_eq!(
            probe.requested_controller_state(),
            if index == 0 { wario } else { left },
        );
    }
}

#[derive(Clone, Debug, Default)]
struct SparseMem {
    bytes: BTreeMap<u32, u8>,
}

impl CheckedMem1 for SparseMem {
    fn read_exact(&self, effective_address: u32, out: &mut [u8]) -> Result<(), Mem1ReadFault> {
        for (offset, byte) in out.iter_mut().enumerate() {
            let offset = u32::try_from(offset).map_err(|_| Mem1ReadFault::CrossesMapping)?;
            let address = effective_address
                .checked_add(offset)
                .ok_or(Mem1ReadFault::CrossesMapping)?;
            *byte = *self.bytes.get(&address).ok_or(Mem1ReadFault::Unmapped)?;
        }
        Ok(())
    }
}

impl SparseMem {
    fn bytes(&mut self, address: u32, bytes: &[u8]) {
        for (offset, byte) in bytes.iter().copied().enumerate() {
            self.bytes
                .insert(address + u32::try_from(offset).unwrap(), byte);
        }
    }

    fn range_ends(&mut self, address: u32, length: u32) {
        self.u8(address, 0);
        self.u8(address + length - 1, 0);
    }

    fn remove(&mut self, address: u32, length: u32) {
        for offset in 0..length {
            self.bytes.remove(&(address + offset));
        }
    }

    fn u8(&mut self, address: u32, value: u8) {
        self.bytes.insert(address, value);
    }

    fn i8(&mut self, address: u32, value: i8) {
        self.bytes(address, &value.to_be_bytes());
    }

    fn u16(&mut self, address: u32, value: u16) {
        self.bytes(address, &value.to_be_bytes());
    }

    fn i16(&mut self, address: u32, value: i16) {
        self.bytes(address, &value.to_be_bytes());
    }

    fn u32(&mut self, address: u32, value: u32) {
        self.bytes(address, &value.to_be_bytes());
    }

    fn i32(&mut self, address: u32, value: i32) {
        self.bytes(address, &value.to_be_bytes());
    }

    fn f32(&mut self, address: u32, value: f32) {
        self.u32(address, value.to_bits());
    }

    fn vec3(&mut self, address: u32, value: [f32; 3]) {
        for (index, component) in value.into_iter().enumerate() {
            self.f32(address + u32::try_from(index).unwrap() * 4, component);
        }
    }

    fn strided_transform(&mut self, player: u32, right: [f32; 3], forward: [f32; 3]) {
        let up = [0.0, 0.0, 1.0];
        let position = [10.0, 20.0, 30.0];
        for row in 0..3_u32 {
            self.f32(player + 0x34 + row * 0x10, right[row as usize]);
            self.f32(player + 0x38 + row * 0x10, forward[row as usize]);
            self.f32(player + 0x3c + row * 0x10, up[row as usize]);
            self.f32(player + 0x40 + row * 0x10, position[row as usize]);
        }
    }
}

fn baseline_presentation() -> PresentationIdentity {
    PresentationIdentity {
        render_sequence: 10,
        presentation_serial: 20,
        xfb_generation: 30,
        selected_row: 0,
        mode: ViPresentationMode::SingleField,
        parity: ViFieldParity::Top,
        pair_epoch: 40,
        output_width: 640,
        output_height: 480,
        status: RenderPresentationStatus::Presented,
    }
}

fn later_presentation() -> PresentationIdentity {
    PresentationIdentity {
        render_sequence: 11,
        presentation_serial: 21,
        xfb_generation: 31,
        selected_row: 1,
        mode: ViPresentationMode::SingleField,
        parity: ViFieldParity::Bottom,
        pair_epoch: 41,
        output_width: 640,
        output_height: 480,
        status: RenderPresentationStatus::Presented,
    }
}

fn host_buttons(id: ProjectorId) -> u32 {
    if id == ProjectorId::WarioWareRepellionA {
        0x0100
    } else {
        0x0001
    }
}

fn publication_state(id: ProjectorId) -> ControllerInputState {
    if id == ProjectorId::WarioWareRepellionA {
        ControllerInputState {
            buttons: 0x0100,
            analog_a: u8::MAX,
            ..ControllerInputState::default()
        }
    } else {
        ControllerInputState {
            buttons: 0x0001,
            stick_x: 0x01,
            ..ControllerInputState::default()
        }
    }
}

fn valid_publication(id: ProjectorId) -> SiPublication {
    let state = publication_state(id);
    let mode = 3;
    SiPublication {
        scheduled_cycle: 110,
        observed_cycle: 120,
        poll_index: 11,
        sequence: 6,
        source: PublicationSource::Periodic,
        buttons: host_buttons(id),
        state,
        mode,
        packet: state.packet(mode),
    }
}

fn selected_probe(id: ProjectorId) -> GameFidelityProbe {
    let (disc, revision, _) = IDENTITIES
        .iter()
        .copied()
        .find(|(_, _, candidate)| *candidate == id)
        .unwrap();
    GameFidelityProbe::select(AuthenticatedDiscIdentity { id: disc, revision }, 7).unwrap()
}

fn armed_probe(id: ProjectorId, memory: &SparseMem) -> GameFidelityProbe {
    let mut probe = selected_probe(id);
    probe
        .arm(
            memory,
            ArmObservation {
                cycle: 100,
                controller_poll_index: 10,
                controller_applied_sequence: 5,
                presentation_cycle: 90,
                presentation: baseline_presentation(),
            },
        )
        .unwrap();
    probe
}

fn run_acceptance(id: ProjectorId, memory: &mut SparseMem) -> GameFidelityProbe {
    let mut probe = armed_probe(id, memory);
    probe.observe_publication(valid_publication(id)).unwrap();
    set_receipt(id, memory);
    probe
        .observe_guest_receipt(
            memory,
            GuestReceipt {
                cycle: 130,
                poll_index: 11,
                applied_sequence: 6,
            },
        )
        .unwrap();
    set_post(id, memory);
    probe.observe_post(memory, 150).unwrap();
    probe
        .observe_presentation(PresentationObservation {
            cycle: 160,
            presentation: later_presentation(),
        })
        .unwrap();
    probe
}

fn run_wario_acceptance_at(memory: &mut SparseMem, runtime: u32, player: u32) -> GameFidelityProbe {
    let id = ProjectorId::WarioWareRepellionA;
    let mut probe = armed_probe(id, memory);
    probe.observe_publication(valid_publication(id)).unwrap();
    memory.u16(runtime + 0x4b160, 0x0100);
    probe
        .observe_guest_receipt(
            memory,
            GuestReceipt {
                cycle: 130,
                poll_index: 11,
                applied_sequence: 6,
            },
        )
        .unwrap();
    memory.u16(runtime + 0x4b160, 0);
    memory.i32(player + 0x1230, 1);
    probe.observe_post(memory, 150).unwrap();
    probe
        .observe_presentation(PresentationObservation {
            cycle: 160,
            presentation: later_presentation(),
        })
        .unwrap();
    probe
}

fn probe_through_receipt(id: ProjectorId, memory: &mut SparseMem) -> GameFidelityProbe {
    let mut probe = armed_probe(id, memory);
    probe.observe_publication(valid_publication(id)).unwrap();
    set_receipt(id, memory);
    probe
        .observe_guest_receipt(
            memory,
            GuestReceipt {
                cycle: 130,
                poll_index: 11,
                applied_sequence: 6,
            },
        )
        .unwrap();
    probe
}

fn probe_through_post(id: ProjectorId, memory: &mut SparseMem) -> GameFidelityProbe {
    let mut probe = probe_through_receipt(id, memory);
    set_post(id, memory);
    probe.observe_post(memory, 150).unwrap();
    probe
}

fn baseline_fixture(id: ProjectorId) -> SparseMem {
    let mut memory = SparseMem::default();
    match id {
        ProjectorId::WarioWareRepellionA => wario_baseline(&mut memory),
        ProjectorId::LuigisMansionFoyerLeft => luigi_baseline(&mut memory),
        ProjectorId::WindWakerOutsetLeft => wind_waker_baseline(&mut memory),
        ProjectorId::MeleeActiveMatchLeft => melee_baseline(&mut memory),
        ProjectorId::FzeroActiveRaceSteer => fzero_baseline(&mut memory),
        ProjectorId::MetroidPrimeFrigateLeftTurn => metroid_baseline(&mut memory),
        ProjectorId::RogueLeaderXwingLeftResponse => rogue_baseline(&mut memory),
    }
    memory
}

fn set_receipt(id: ProjectorId, memory: &mut SparseMem) {
    match id {
        ProjectorId::WarioWareRepellionA => memory.u16(0x802f_6580, 0x0100),
        ProjectorId::LuigisMansionFoyerLeft => {
            memory.vec3(0x803a_3ca0, [11.0, 0.0, 20.0]);
            memory.vec3(0x8040_0044, [11.0, 0.0, 20.0]);
            memory.u32(0x8041_0018, 0x0100_0001);
            memory.u32(0x8041_001c, 0x0100_0001);
            memory.f32(0x8041_0044, -1.0);
            memory.f32(0x8041_0048, 0.0);
            memory.f32(0x8041_004c, 1.0);
            memory.f32(0x8042_01c0, 1.0);
        }
        ProjectorId::WindWakerOutsetLeft => {
            memory.vec3(0x8040_01f8, [11.0, 0.0, 20.0]);
            memory.f32(0x803a_4df0, -1.0);
            memory.f32(0x803a_4df4, 0.0);
            memory.f32(0x803a_4df8, 1.0);
            memory.u16(0x803a_4e20, 0x8000);
        }
        ProjectorId::MeleeActiveMatchLeft => {
            memory.u32(0x8046_b6c4, 101);
            memory.i32(0x8045_3120, 11);
            memory.i32(0x8043_0010, 15);
            memory.vec3(0x8043_00b0, [9.9, 0.0, 0.0]);
            memory.u32(0x804c_21cc, 0x0004_0001);
            memory.u32(0x804c_21d4, 0x0004_0001);
            memory.i8(0x804c_21e4, -80);
            memory.i8(0x804c_21e5, 0);
            memory.f32(0x804c_21ec, -1.0);
            memory.f32(0x804c_21f0, 0.0);
            memory.f32(0x8043_0620, -1.0);
            memory.f32(0x8043_0624, 0.0);
            memory.u32(0x8043_065c, 0x0004_0001);
            memory.u32(0x8043_0668, 0x0004_0001);
        }
        ProjectorId::FzeroActiveRaceSteer => {
            memory.vec3(0x8040_007c, [11.0, 0.0, 0.0]);
            memory.f32(0x8040_01fc, -0.8);
            memory.f32(0x8040_020c, -0.8);
            memory.u32(0x8040_047c, 101);
        }
        ProjectorId::MetroidPrimeFrigateLeftTurn => {
            memory.u32(0x8045_badc, 101);
            memory.u32(0x8045_bae0, 201);
            memory.f32(0x8045_bd64, -1.0);
            memory.u8(0x8045_bd89, 0x20);
        }
        ProjectorId::RogueLeaderXwingLeftResponse => {
            rogue_input(memory, -72, 0, -1.0, 0.0);
            memory.f32(0x7fdf_2460, 0.5);
        }
    }
}

fn set_post(id: ProjectorId, memory: &mut SparseMem) {
    match id {
        ProjectorId::WarioWareRepellionA => {
            memory.u16(0x802f_6580, 0);
            memory.i32(0x802a_a230, 1);
        }
        ProjectorId::LuigisMansionFoyerLeft => {
            memory.vec3(0x803a_3ca0, [12.0, 0.0, 20.0]);
            memory.vec3(0x8040_0044, [12.0, 0.0, 20.0]);
        }
        ProjectorId::WindWakerOutsetLeft => {
            memory.vec3(0x8040_01f8, [12.0, 0.0, 20.0]);
        }
        ProjectorId::MeleeActiveMatchLeft => {
            memory.u32(0x8046_b6c4, 102);
            memory.i32(0x8045_3120, 11);
            memory.i32(0x8043_0010, 15);
            memory.vec3(0x8043_00b0, [9.0, 0.0, 0.0]);
            memory.vec3(0x8043_00bc, [9.2, 0.0, 0.0]);
            memory.f32(0x8043_0080, -1.0);
            memory.f32(0x8043_00c8, -0.2);
        }
        ProjectorId::FzeroActiveRaceSteer => {
            memory.vec3(0x8040_007c, [12.0, 0.0, 0.0]);
            memory.u32(0x8040_047c, 102);
        }
        ProjectorId::MetroidPrimeFrigateLeftTurn => {
            memory.u32(0x8045_badc, 102);
            memory.u32(0x8045_bae0, 202);
            let cosine = 0.999_95_f32;
            memory.strided_transform(0x8046_c9e8, [cosine, -0.01, 0.0], [0.01, cosine, 0.0]);
        }
        ProjectorId::RogueLeaderXwingLeftResponse => rogue_input(memory, 0, 0, 0.0, 0.0),
    }
}

fn wario_baseline(memory: &mut SparseMem) {
    const RUNTIME: u32 = 0x802a_b420;
    const PLAYER: u32 = 0x802a_9000;
    wario_baseline_at(memory, RUNTIME, PLAYER);
}

fn wario_baseline_at(memory: &mut SparseMem, runtime: u32, player: u32) {
    memory.u32(0x8029_5ed0, 0x63);
    memory.i32(0x8029_58ac, 0);
    memory.u32(0x802f_6860, runtime);
    memory.range_ends(runtime, 0x4b3fc);
    memory.u16(runtime + 0x4b160, 0);
    memory.u32(runtime + 0x4b178, player);
    memory.range_ends(player, 0x1234);
    memory.i32(player + 0x1230, 0);
}

fn luigi_baseline(memory: &mut SparseMem) {
    const ROOT: u32 = 0x803a_8000;
    const MANAGER: u32 = 0x803a_9000;
    const PLAYER: u32 = 0x8040_0000;
    const PAD: u32 = 0x8041_0000;
    const CONTROLLER: u32 = 0x8042_0000;
    memory.u32(0x804d_80a0, 2);
    memory.u32(0x804d_80c4, 0);
    memory.u32(0x804d_80c8, 2);
    memory.u32(0x804d_8728, 2);
    memory.u32(0x803a_3cac, 0x0200_0102);
    memory.i16(0x804d_8374, 0);
    memory.u32(0x804d_8c60, ROOT);
    memory.range_ends(ROOT, 12);
    memory.u32(ROOT + 8, MANAGER);
    memory.range_ends(MANAGER, 0xe0c);
    memory.u32(MANAGER + 0xe08, 4);
    memory.u32(0x803d_48b0, PLAYER);
    memory.range_ends(PLAYER, 0x1070);
    memory.u32(PLAYER, 0x8035_9d48);
    memory.u32(PLAYER + 0xb4, 0x0200_0102);
    memory.vec3(0x803a_3ca0, [10.0, 0.0, 20.0]);
    memory.vec3(PLAYER + 0x44, [10.0, 0.0, 20.0]);
    memory.u16(PLAYER + 0x88, 0x1000);
    memory.u32(0x804d_8078, PAD);
    memory.range_ends(PAD, 0x77);
    memory.u32(PLAYER + 0x794, PAD);
    memory.u32(PLAYER + 0x7d4, CONTROLLER);
    memory.range_ends(CONTROLLER, 0x1e0);
    memory.i16(PLAYER + 0xfc, 100);
    memory.u8(PLAYER + 0x1042, 0);
    memory.u8(PLAYER + 0x1058, 0);
    memory.f32(PLAYER + 0x105c, 0.0);
    memory.f32(PLAYER + 0x106c, 0.0);
    memory.i16(PAD + 0x74, 0);
    memory.u8(PAD + 0x76, 0);
    memory.u32(CONTROLLER + 0x1b0, PAD);
    memory.u32(PAD + 0x18, 0);
    memory.u32(PAD + 0x1c, 0);
    memory.f32(PAD + 0x44, 0.0);
    memory.f32(PAD + 0x48, 0.0);
    memory.f32(PAD + 0x4c, 0.0);
    memory.f32(CONTROLLER + 0x1c0, 0.0);
    memory.f32(CONTROLLER + 0x1dc, 0.0);
}

fn wind_waker_baseline(memory: &mut SparseMem) {
    const PLAYER: u32 = 0x8040_0000;
    memory.bytes(0x803c_9d3c, b"sea\0\0\0\0\0");
    memory.u8(0x803c_9d46, 44);
    memory.u8(0x803f_6a78, 44);
    memory.u8(0x803c_9ea2, 0);
    memory.u8(0x803f_7097, 0);
    memory.u8(0x803f_72b0, 0);
    memory.u32(0x803c_a74c, PLAYER);
    memory.u32(0x803c_a754, PLAYER);
    memory.range_ends(PLAYER, 0x4c28);
    memory.u16(PLAYER + 8, 0x00a9);
    memory.u32(PLAYER + 0x10, 0x8038_fd8c);
    memory.u8(PLAYER + 0x0b, 0);
    memory.u8(PLAYER + 0x20a, 44);
    memory.vec3(PLAYER + 0x1f8, [10.0, 0.0, 20.0]);
    memory.u16(PLAYER + 0x206, 0x1000);
    memory.f32(0x803a_4df0, 0.0);
    memory.f32(0x803a_4df4, 0.0);
    memory.f32(0x803a_4df8, 0.0);
    memory.u16(0x803a_4e20, 0);
    memory.u16(0x803a_4e22, 0);
    memory.u8(0x803a_4e24, 0);
}

fn melee_baseline(memory: &mut SparseMem) {
    const ROUTING: u32 = 0x8047_9d30;
    const MATCH: u32 = 0x8046_b6a0;
    const SLOT: u32 = 0x8045_3080;
    const ENTITY: u32 = 0x8042_0000;
    const FIGHTER: u32 = 0x8043_0000;
    const PAD: u32 = 0x804c_21cc;
    memory.u32(0x804d_6720, 0x803d_d9dc);
    memory.range_ends(0x803d_d9dc, 12);
    memory.u8(0x803d_d9dc, 2);
    memory.u32(0x803d_d9e0, 0x8048_0530);
    memory.u32(0x803d_d9e4, 0x8047_9d98);
    memory.u8(ROUTING, 2);
    memory.u8(ROUTING + 3, 2);
    memory.u8(ROUTING + 0x0c, 0);
    memory.u8(MATCH, 0);
    memory.u8(MATCH + 2, 0);
    memory.u8(MATCH + 4, 0);
    memory.u8(MATCH + 5, 1);
    memory.u8(MATCH + 6, 0);
    memory.u8(MATCH + 7, 0);
    memory.u8(MATCH + 8, 0);
    memory.u8(MATCH + 0x0e, 0);
    memory.u32(MATCH + 0x24, 100);
    memory.u8(MATCH + 0x3a, 0);
    memory.u8(MATCH + 0x42, 0);
    memory.u8(0x8047_9d68, 0);
    for index in 1..=3_u32 {
        let opponent = SLOT + index * 0xe90;
        memory.i32(opponent, if index == 1 { 2 } else { 0 });
        memory.i32(opponent + 8, if index == 1 { 1 } else { 2 });
    }
    memory.i32(SLOT, 2);
    memory.i32(SLOT + 4, 3);
    memory.i32(SLOT + 8, 0);
    memory.u8(SLOT + 0x0c, 0);
    memory.u8(SLOT + 0x46, 1);
    memory.u8(SLOT + 0x48, 0);
    memory.u8(SLOT + 0x8e, 4);
    memory.i32(SLOT + 0xa0, 10);
    memory.u32(SLOT + 0xb0, ENTITY);
    memory.range_ends(ENTITY, 0x38);
    memory.u16(ENTITY, 4);
    memory.u8(ENTITY + 2, 8);
    memory.u8(ENTITY + 4, 0);
    memory.u8(ENTITY + 7, 4);
    memory.u32(ENTITY + 0x2c, FIGHTER);
    memory.range_ends(FIGHTER, 0x23ec);
    memory.u32(FIGHTER, ENTITY);
    memory.i32(FIGHTER + 4, 3);
    memory.u8(FIGHTER + 0x0c, 0);
    memory.i32(FIGHTER + 0x10, 14);
    memory.i32(FIGHTER + 0xe0, 0);
    memory.u8(FIGHTER + 0x618, 0);
    memory.u8(FIGHTER + 0x61a, 1);
    memory.vec3(FIGHTER + 0xb0, [10.0, 0.0, 0.0]);
    memory.vec3(FIGHTER + 0xbc, [10.0, 0.0, 0.0]);
    memory.f32(FIGHTER + 0x80, 0.0);
    memory.f32(FIGHTER + 0xc8, 0.0);
    memory.f32(FIGHTER + 0x620, 0.0);
    memory.f32(FIGHTER + 0x624, 0.0);
    memory.u32(FIGHTER + 0x65c, 0);
    memory.u32(FIGHTER + 0x668, 0);
    memory.u32(PAD, 0);
    memory.u32(PAD + 8, 0);
    memory.i8(PAD + 0x18, 0);
    memory.i8(PAD + 0x19, 0);
    memory.f32(PAD + 0x20, 0.0);
    memory.f32(PAD + 0x24, 0.0);
    memory.u8(PAD + 0x41, 0);
}

fn fzero_baseline(memory: &mut SparseMem) {
    const REFERENCE: u32 = 0x8001_0000;
    const RACER: u32 = 0x8040_0000;
    memory.u32(0x8000_30c8, REFERENCE);
    memory.u8(REFERENCE, 0);
    memory.u32(REFERENCE + 0x0022_7878, RACER);
    memory.range_ends(RACER, 0x620);
    memory.u32(RACER, 0);
    memory.u16(RACER + 4, 1);
    memory.u16(RACER + 6, 2);
    memory.vec3(RACER + 0x07c, [10.0, 0.0, 0.0]);
    memory.vec3(RACER + 0x088, [9.0, 0.0, 0.0]);
    memory.vec3(RACER + 0x094, [1.0, 0.0, 0.0]);
    memory.vec3(RACER + 0x0b8, [1.0, 0.0, 0.0]);
    memory.vec3(RACER + 0x0ec, [1.0, 0.0, 0.0]);
    memory.vec3(RACER + 0x1bc, [1.0, 0.0, 0.0]);
    memory.f32(RACER + 0x17c, 100.0);
    memory.f32(RACER + 0x184, 1.0);
    memory.u32(RACER + 0x194, 0);
    memory.i32(RACER + 0x1cc, 1);
    memory.f32(RACER + 0x1d0, 0.5);
    memory.f32(RACER + 0x1f4, 0.0);
    memory.f32(RACER + 0x1f8, 0.0);
    memory.f32(RACER + 0x1fc, 0.0);
    memory.f32(RACER + 0x200, 1.0);
    memory.f32(RACER + 0x204, 0.0);
    memory.f32(RACER + 0x20c, 0.0);
    memory.u16(RACER + 0x214, 0);
    memory.i8(RACER + 0x474, 0);
    memory.u32(RACER + 0x47c, 100);
    memory.u8(RACER + 0x4b3, 0);
    memory.u8(RACER + 0x590, 1);
    memory.u8(RACER + 0x593, 0);
    memory.u8(RACER + 0x5d8, 0);
}

fn metroid_baseline(memory: &mut SparseMem) {
    const MANAGER: u32 = 0x8045_b208;
    const PLAYER: u32 = 0x8046_c9e8;
    const WORLD: u32 = 0x8041_0000;
    const CAMERA_MANAGER: u32 = 0x8042_0000;
    const FIRST_PERSON_CAMERA: u32 = 0x8043_0000;
    const STATE_REF: u32 = 0x8044_0000;
    const PLAYER_STATE: u32 = 0x8044_1000;
    const INPUT: u32 = MANAGER + 0xb54;
    memory.u32(0x8000_0000, 0x474d_3845);
    memory.u16(0x8000_0004, 0x3031);
    memory.u8(0x8000_0006, 0);
    memory.u8(0x8000_0007, 2);
    memory.range_ends(MANAGER, 0xb84);
    memory.u32(MANAGER + 0x84c, PLAYER);
    memory.u32(MANAGER + 0x850, WORLD);
    memory.u32(MANAGER + 0x870, CAMERA_MANAGER);
    memory.u32(MANAGER + 0x8b8, STATE_REF);
    memory.range_ends(WORLD, 0x6c);
    memory.u32(WORLD + 8, 0x158e_fe17);
    memory.i32(WORLD + 0x68, 0);
    memory.range_ends(CAMERA_MANAGER, 0x3cc);
    memory.u16(CAMERA_MANAGER, 7);
    memory.u32(CAMERA_MANAGER + 8, 0);
    memory.u32(CAMERA_MANAGER + 0x88, FIRST_PERSON_CAMERA);
    memory.range_ends(FIRST_PERSON_CAMERA, 0x198);
    memory.u16(FIRST_PERSON_CAMERA + 8, 7);
    memory.u8(FIRST_PERSON_CAMERA + 0x180, 0);
    memory.range_ends(STATE_REF, 8);
    memory.u32(STATE_REF, PLAYER_STATE);
    memory.i32(STATE_REF + 4, 1);
    memory.range_ends(PLAYER_STATE, 0x198);
    memory.u8(PLAYER_STATE, 0x80);
    memory.i32(MANAGER + 0x8cc, 0);
    memory.u32(MANAGER + 0x8d4, 100);
    memory.u32(MANAGER + 0x8d8, 200);
    memory.u32(MANAGER + 0x904, 0);
    memory.u32(MANAGER + 0xb3c, 2);
    memory.range_ends(PLAYER, 0xa48);
    memory.i32(PLAYER + 4, 0);
    memory.u16(PLAYER + 8, 9);
    memory.u8(PLAYER + 0x30, 0x80);
    memory.u32(PLAYER + 0x268, 0);
    memory.u32(PLAYER + 0x2bc, 0);
    memory.u32(PLAYER + 0x304, 0);
    memory.u32(PLAYER + 0x308, 0);
    memory.u32(PLAYER + 0x314, 0);
    memory.f32(PLAYER + 0x760, 0.0);
    memory.u8(PLAYER + 0x770, 0);
    memory.u8(PLAYER + 0x9d6, 0);
    memory.f32(PLAYER + 0xa04, 0.0);
    memory.strided_transform(PLAYER, [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]);
    memory.vec3(PLAYER + 0x154, [0.0, 0.0, 0.0]);
    memory.vec3(PLAYER + 0x184, [0.0, 0.0, 0.0]);
    memory.f32(INPUT, 1.0 / 60.0);
    memory.u32(INPUT + 4, 0);
    for offset in [8, 0x0c, 0x10, 0x14, 0x18, 0x1c, 0x24, 0x28] {
        memory.f32(INPUT + offset, 0.0);
    }
    memory.u8(INPUT + 0x2c, 0);
    memory.u8(INPUT + 0x2d, 0);
    memory.u8(INPUT + 0x2e, 0);
}

fn rogue_input(memory: &mut SparseMem, raw_x: i8, raw_y: i8, shaped_x: f32, shaped_y: f32) {
    const PAD: u32 = 0x7fde_e6e8;
    const NORMALIZED: u32 = 0x7fde_e718;
    const GLOBAL: u32 = 0x7fde_97e0;
    const CONTROL: u32 = 0x7fdf_0fa4;
    memory.u16(PAD, 0);
    memory.i8(PAD + 2, raw_x);
    memory.i8(PAD + 3, raw_y);
    memory.i8(PAD + 0x0a, 0);
    let x = f32::from(raw_x) / 72.0;
    let y = f32::from(raw_y) / 72.0;
    memory.f32(NORMALIZED, x);
    memory.f32(NORMALIZED + 4, y);
    memory.f32(GLOBAL, x);
    memory.f32(GLOBAL + 4, -y);
    memory.f32(CONTROL + 8, shaped_x);
    memory.f32(CONTROL + 12, shaped_y);
}

fn rogue_baseline(memory: &mut SparseMem) {
    const MANAGER: u32 = 0x7fde_fe14;
    const CRAFT: u32 = 0x7fdf_2000;
    const CONFIG: u32 = 0x7fdf_3000;
    const CONTROL: u32 = 0x7fdf_0fa4;
    memory.u32(0x8000_0000, 0x4753_5745);
    memory.u16(0x8000_0004, 0x3634);
    memory.u8(0x8000_0006, 0);
    memory.u8(0x8000_0007, 0);
    memory.u32(MANAGER, CRAFT);
    memory.i32(MANAGER + 4, 3);
    memory.i32(MANAGER + 8, 0);
    memory.u8(CRAFT, 0);
    memory.u32(CRAFT + 0x80, 0x7fdc_75b8);
    memory.u32(CRAFT + 0x1a0, 0x7fdc_760c);
    memory.i32(CRAFT + 0x370, 0);
    memory.u32(CRAFT + 0x37c, CONFIG);
    memory.u32(CRAFT + 0x380, CONTROL);
    memory.u8(CONFIG, 0);
    memory.u8(CONTROL, 0);
    memory.u32(CONTROL + 0x110, 0);
    memory.u32(CONTROL + 0x10c, 1);
    memory.f32(CRAFT + 0x45c, 0.0);
    memory.f32(CRAFT + 0x460, 0.0);
    memory.f32(CRAFT + 0x464, 0.0);
    memory.vec3(CRAFT + 0x84, [1.0, 0.0, 0.0]);
    memory.vec3(CRAFT + 0x90, [0.0, 1.0, 0.0]);
    memory.vec3(CRAFT + 0x9c, [0.0, 0.0, 1.0]);
    memory.vec3(CRAFT + 0xa8, [10.0, 20.0, 30.0]);
    memory.vec3(CRAFT + 0xb4, [1.0, 0.0, 0.0]);
    memory.i32(0x7fde_822c, 1);
    memory.i32(0x7fde_8230, 2);
    rogue_input(memory, 0, 0, 0.0, 0.0);
}

#[test]
fn all_seven_projectors_accept_only_the_complete_authenticated_path() {
    for (_, _, id) in IDENTITIES {
        let mut memory = baseline_fixture(id);
        let probe = run_acceptance(id, &mut memory);
        let record = probe.record();
        assert_eq!(record.phase(), ProbePhase::Accepted, "{id:?}");
        assert_eq!(record.failure(), FailureCode::None, "{id:?}");
        assert_eq!(
            record.passed_predicates() & record.required_predicates(),
            record.required_predicates(),
            "{id:?}",
        );
        assert_eq!(record.failed_predicates(), 0, "{id:?}");
        assert_eq!(probe.record_bytes(), record.to_bytes());
    }
}

#[test]
fn canonical_record_is_fixed_size_and_packs_authenticated_presentations() {
    let mut memory = baseline_fixture(ProjectorId::WarioWareRepellionA);
    let probe = run_acceptance(ProjectorId::WarioWareRepellionA, &mut memory);
    let bytes = probe.record_bytes();
    assert_eq!(bytes.len(), GAME_FIDELITY_RECORD_BYTES);
    assert_eq!(&bytes[0..4], b"GFP1");
    assert_eq!(
        u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
        GAME_FIDELITY_RECORD_VERSION
    );
    assert_eq!(u32::from_le_bytes(bytes[8..12].try_into().unwrap()), 384);
    assert_eq!(
        u32::from_le_bytes(bytes[12..16].try_into().unwrap()),
        ProbePhase::Accepted as u32
    );
    assert_eq!(u32::from_le_bytes(bytes[28..32].try_into().unwrap()), 0);
    assert_eq!(u64::from_le_bytes(bytes[320..328].try_into().unwrap()), 10);
    assert_eq!(
        u32::from_le_bytes(bytes[340..344].try_into().unwrap()),
        0x0002_0001
    );
    assert_eq!(u64::from_le_bytes(bytes[352..360].try_into().unwrap()), 11);
    assert_eq!(
        u32::from_le_bytes(bytes[372..376].try_into().unwrap()),
        0x0002_0101
    );
}

#[test]
fn exported_semantic_hashes_are_invariant_to_guest_object_relocation() {
    let id = ProjectorId::WarioWareRepellionA;
    const ORDINARY_RUNTIME: u32 = 0x802a_b420;
    const ORDINARY_PLAYER: u32 = 0x802a_9000;
    const RELOCATED_RUNTIME: u32 = 0x8031_0000;
    const RELOCATED_PLAYER: u32 = 0x8030_0000;
    let mut ordinary = baseline_fixture(id);
    let mut relocated = SparseMem::default();
    wario_baseline_at(&mut relocated, RELOCATED_RUNTIME, RELOCATED_PLAYER);

    let ordinary_bytes =
        run_wario_acceptance_at(&mut ordinary, ORDINARY_RUNTIME, ORDINARY_PLAYER).record_bytes();
    let relocated_bytes =
        run_wario_acceptance_at(&mut relocated, RELOCATED_RUNTIME, RELOCATED_PLAYER).record_bytes();
    assert_eq!(
        &ordinary_bytes[192..288],
        &relocated_bytes[192..288],
        "exported baseline/receipt/post projections cannot encode guest pointer placement",
    );

    let mut lifetime_drift = baseline_fixture(id);
    let mut probe = armed_probe(id, &lifetime_drift);
    probe.observe_publication(valid_publication(id)).unwrap();
    set_receipt(id, &mut lifetime_drift);
    lifetime_drift.u32(0x802f_6598, RELOCATED_PLAYER);
    lifetime_drift.range_ends(RELOCATED_PLAYER, 0x1234);
    lifetime_drift.i32(RELOCATED_PLAYER + 0x1230, 0);
    assert_eq!(
        probe.observe_guest_receipt(
            &lifetime_drift,
            GuestReceipt {
                cycle: 130,
                poll_index: 11,
                applied_sequence: 6,
            },
        ),
        Err(FailureCode::Lifetime),
        "private lifetime binding must still reject relocation within one probe",
    );
}

#[test]
fn fzero_record_witness_is_the_guest_steer_bit_pattern() {
    let mut memory = baseline_fixture(ProjectorId::FzeroActiveRaceSteer);
    let probe = run_acceptance(ProjectorId::FzeroActiveRaceSteer, &mut memory);
    let bytes = probe.record_bytes();
    assert_eq!(
        u32::from_le_bytes(bytes[188..192].try_into().unwrap()),
        (-0.8_f32).to_bits(),
    );
}

#[test]
fn publication_is_exactly_bound_to_the_rust_si_packet_and_order() {
    let id = ProjectorId::WarioWareRepellionA;
    let memory = baseline_fixture(id);

    let mut packet_mismatch = armed_probe(id, &memory);
    let mut publication = valid_publication(id);
    publication.packet[1] ^= 1;
    assert_eq!(
        packet_mismatch.observe_publication(publication),
        Err(FailureCode::Predicate),
    );
    assert_eq!(packet_mismatch.record().phase(), ProbePhase::Failed);
    assert_eq!(
        packet_mismatch.observe_publication(valid_publication(id)),
        Err(FailureCode::Predicate),
        "the first failure remains authoritative",
    );

    let mut source_mismatch = armed_probe(id, &memory);
    let mut publication = valid_publication(id);
    publication.state.stick_x = 0x01;
    publication.packet = publication.state.packet(publication.mode);
    assert_eq!(
        source_mismatch.observe_publication(publication),
        Err(FailureCode::Predicate),
        "a self-consistent packet cannot substitute a different normalized source state",
    );

    let mut backwards = armed_probe(id, &memory);
    let mut publication = valid_publication(id);
    publication.scheduled_cycle = 121;
    assert_eq!(
        backwards.observe_publication(publication),
        Err(FailureCode::Chronology),
    );

    let mut stale = armed_probe(id, &memory);
    let mut publication = valid_publication(id);
    publication.sequence = 5;
    assert_eq!(
        stale.observe_publication(publication),
        Err(FailureCode::Sequence),
    );

    let mut direct = armed_probe(id, &memory);
    let mut publication = valid_publication(id);
    publication.source = PublicationSource::Direct;
    direct.observe_publication(publication).unwrap();
    assert_eq!(direct.record().phase(), ProbePhase::Published);
}

#[test]
fn receipt_requires_matching_applied_sequence_poll_and_chronology() {
    let id = ProjectorId::WindWakerOutsetLeft;
    for (receipt, expected) in [
        (
            GuestReceipt {
                cycle: 119,
                poll_index: 11,
                applied_sequence: 6,
            },
            FailureCode::Chronology,
        ),
        (
            GuestReceipt {
                cycle: 130,
                poll_index: 11,
                applied_sequence: 7,
            },
            FailureCode::Sequence,
        ),
        (
            GuestReceipt {
                cycle: 130,
                poll_index: 10,
                applied_sequence: 6,
            },
            FailureCode::Sequence,
        ),
    ] {
        let mut memory = baseline_fixture(id);
        let mut probe = armed_probe(id, &memory);
        probe.observe_publication(valid_publication(id)).unwrap();
        set_receipt(id, &mut memory);
        assert_eq!(probe.observe_guest_receipt(&memory, receipt), Err(expected),);
        assert_eq!(probe.record().phase(), ProbePhase::Failed);
    }
}

#[test]
fn every_title_milestone_predicate_fails_closed_on_drift() {
    for (_, _, id) in IDENTITIES {
        let mut memory = baseline_fixture(id);
        match id {
            ProjectorId::WarioWareRepellionA => memory.u32(0x8029_5ed0, 0x62),
            ProjectorId::LuigisMansionFoyerLeft => memory.u32(0x804d_80a0, 1),
            ProjectorId::WindWakerOutsetLeft => memory.u8(0x803c_9d46, 43),
            ProjectorId::MeleeActiveMatchLeft => memory.u8(0x8047_9d30, 1),
            ProjectorId::FzeroActiveRaceSteer => memory.u32(0x8040_0000, 0x80),
            ProjectorId::MetroidPrimeFrigateLeftTurn => {
                memory.u32(0x8041_0008, 0x158e_fe16);
            }
            ProjectorId::RogueLeaderXwingLeftResponse => {
                memory.i8(0x7fde_e6f2, -1);
            }
        }
        let mut probe = selected_probe(id);
        assert_eq!(
            probe.arm(
                &memory,
                ArmObservation {
                    cycle: 100,
                    controller_poll_index: 10,
                    controller_applied_sequence: 5,
                    presentation_cycle: 90,
                    presentation: baseline_presentation(),
                },
            ),
            Err(FailureCode::Predicate),
            "{id:?}",
        );
        assert_eq!(probe.record().phase(), ProbePhase::Failed, "{id:?}");
    }
}

#[test]
fn memory_pointer_nonfinite_and_lifetime_faults_are_typed_and_sticky() {
    let id = ProjectorId::WarioWareRepellionA;

    let mut short = baseline_fixture(id);
    short.remove(0x8029_5ed0, 4);
    let mut probe = selected_probe(id);
    assert_eq!(
        probe.arm(
            &short,
            ArmObservation {
                cycle: 100,
                controller_poll_index: 10,
                controller_applied_sequence: 5,
                presentation_cycle: 90,
                presentation: baseline_presentation(),
            },
        ),
        Err(FailureCode::MemoryRead),
    );

    let mut invalid_pointer = baseline_fixture(id);
    invalid_pointer.u32(0x802f_6860, 0x817b_4c05);
    let mut probe = selected_probe(id);
    assert_eq!(
        probe.arm(
            &invalid_pointer,
            ArmObservation {
                cycle: 100,
                controller_poll_index: 10,
                controller_applied_sequence: 5,
                presentation_cycle: 90,
                presentation: baseline_presentation(),
            },
        ),
        Err(FailureCode::Pointer),
    );

    let rogue = ProjectorId::RogueLeaderXwingLeftResponse;
    let mut overflowing_alias = baseline_fixture(rogue);
    overflowing_alias.u32(0x7fde_fe14, 0xffff_fff0);
    overflowing_alias.u8(0xffff_fff0, 0);
    let mut probe = selected_probe(rogue);
    assert_eq!(
        probe.arm(
            &overflowing_alias,
            ArmObservation {
                cycle: 100,
                controller_poll_index: 10,
                controller_applied_sequence: 5,
                presentation_cycle: 90,
                presentation: baseline_presentation(),
            },
        ),
        Err(FailureCode::Pointer),
    );

    let luigi = ProjectorId::LuigisMansionFoyerLeft;
    let mut nonfinite = baseline_fixture(luigi);
    nonfinite.f32(0x8041_0044, f32::NAN);
    let mut probe = selected_probe(luigi);
    assert_eq!(
        probe.arm(
            &nonfinite,
            ArmObservation {
                cycle: 100,
                controller_poll_index: 10,
                controller_applied_sequence: 5,
                presentation_cycle: 90,
                presentation: baseline_presentation(),
            },
        ),
        Err(FailureCode::NonFinite),
    );

    let mut lifetime = baseline_fixture(id);
    let mut probe = probe_through_receipt(id, &mut lifetime);
    set_post(id, &mut lifetime);
    const REPLACEMENT: u32 = 0x8030_0000;
    lifetime.u32(0x802f_6598, REPLACEMENT);
    lifetime.range_ends(REPLACEMENT, 0x1234);
    lifetime.i32(REPLACEMENT + 0x1230, 1);
    assert_eq!(
        probe.observe_post(&lifetime, 150),
        Err(FailureCode::Lifetime),
    );
    assert_eq!(probe.record().failure(), FailureCode::Lifetime);
}

#[test]
fn causal_thresholds_reject_equality_and_accept_strictly_greater_change() {
    let luigi = ProjectorId::LuigisMansionFoyerLeft;
    let mut no_later_motion = baseline_fixture(luigi);
    let mut probe = probe_through_receipt(luigi, &mut no_later_motion);
    assert_eq!(
        probe.observe_post(&no_later_motion, 150),
        Err(FailureCode::Predicate),
        "post position equal to the receipt is not movement",
    );

    let rogue = ProjectorId::RogueLeaderXwingLeftResponse;
    let mut exact_boundary = baseline_fixture(rogue);
    let mut probe = armed_probe(rogue, &exact_boundary);
    probe.observe_publication(valid_publication(rogue)).unwrap();
    rogue_input(&mut exact_boundary, -72, 0, -1.0, 0.0);
    exact_boundary.f32(0x7fdf_2460, 0.0001);
    probe
        .observe_guest_receipt(
            &exact_boundary,
            GuestReceipt {
                cycle: 130,
                poll_index: 11,
                applied_sequence: 6,
            },
        )
        .unwrap();
    rogue_input(&mut exact_boundary, 0, 0, 0.0, 0.0);
    assert_eq!(
        probe.observe_post(&exact_boundary, 150),
        Err(FailureCode::Predicate),
        "the frozen contract is strictly greater than 0.0001",
    );

    let mut above_boundary = baseline_fixture(rogue);
    let mut probe = armed_probe(rogue, &above_boundary);
    probe.observe_publication(valid_publication(rogue)).unwrap();
    rogue_input(&mut above_boundary, -72, 0, -1.0, 0.0);
    above_boundary.f32(0x7fdf_2460, 0.000_101);
    probe
        .observe_guest_receipt(
            &above_boundary,
            GuestReceipt {
                cycle: 130,
                poll_index: 11,
                applied_sequence: 6,
            },
        )
        .unwrap();
    rogue_input(&mut above_boundary, 0, 0, 0.0, 0.0);
    probe.observe_post(&above_boundary, 150).unwrap();
}

#[test]
fn melee_max_joystick_count_fails_closed_without_overflow() {
    let id = ProjectorId::MeleeActiveMatchLeft;
    let mut memory = baseline_fixture(id);
    memory.i32(0x8045_3120, i32::MAX);
    let mut probe = armed_probe(id, &memory);
    probe.observe_publication(valid_publication(id)).unwrap();
    set_receipt(id, &mut memory);
    memory.i32(0x8045_3120, i32::MAX);
    probe
        .observe_guest_receipt(
            &memory,
            GuestReceipt {
                cycle: 130,
                poll_index: 11,
                applied_sequence: 6,
            },
        )
        .unwrap();
    set_post(id, &mut memory);
    memory.i32(0x8045_3120, i32::MAX);
    assert_eq!(
        probe.observe_post(&memory, 150),
        Err(FailureCode::Predicate),
    );
}

#[test]
fn presentation_must_be_authenticated_presented_later_and_coherent() {
    let id = ProjectorId::WarioWareRepellionA;
    for variant in 0..7 {
        let mut memory = baseline_fixture(id);
        let mut probe = probe_through_post(id, &mut memory);
        let mut presentation = later_presentation();
        let mut cycle = 160;
        match variant {
            0 => presentation.status = RenderPresentationStatus::Staged,
            1 => presentation.presentation_serial = 20,
            2 => presentation.render_sequence = 10,
            3 => presentation.output_width = 608,
            4 => cycle = 150,
            5 => presentation.xfb_generation = 30,
            6 => presentation.pair_epoch = 40,
            _ => unreachable!(),
        }
        assert_eq!(
            probe.observe_presentation(PresentationObservation {
                cycle,
                presentation,
            }),
            Err(FailureCode::Presentation),
        );
        assert_eq!(probe.record().phase(), ProbePhase::Failed);
    }
}

#[test]
fn phase_permutations_poison_without_panicking() {
    let id = ProjectorId::WarioWareRepellionA;
    let memory = baseline_fixture(id);
    let mut probe = selected_probe(id);
    assert_eq!(
        probe.observe_publication(valid_publication(id)),
        Err(FailureCode::WrongPhase),
    );
    assert_eq!(probe.record().phase(), ProbePhase::Failed);
    assert_eq!(
        probe.arm(
            &memory,
            ArmObservation {
                cycle: 100,
                controller_poll_index: 10,
                controller_applied_sequence: 5,
                presentation_cycle: 90,
                presentation: baseline_presentation(),
            },
        ),
        Err(FailureCode::WrongPhase),
    );
}
