use lazuli::Address;
use lazuli::system::mmu::TranslationEffect;
use lazuli::system::scheduler::MachineEventDeadlines;
use lazuli::system::si::{
    CommControl, ControllerInputSample, ControllerInputState, ControllerPublication,
    SerialServiceResult, ViSerialTiming,
};
use lazuli::system::{Config, System};
use lazuli_abi::{
    EvidenceU64, MACHINE_XFB_VI_PAIR_COMPLETING, MachineBootFault, MachineBootStatus,
    MachineDiscFormat, MachineXfbViEvidenceV1, RenderPresentationStatus, ViFieldParity,
    ViPresentationMode,
};

use super::game_fidelity::{CheckedMem1, FailureCode, ProbePhase};
use super::game_fidelity_integration::{GameFidelityIntegration, ProbeMem1};
use super::machine_evidence::{AuthenticatedBootIdentity, AuthenticatedBootState};
use super::{BrowserMachine, IPL_BYTES, nop_modules};

const RUNTIME: u32 = 0x802a_b420;
const PLAYER: u32 = 0x802a_9000;

fn test_system() -> System {
    let mut system = System::new(
        nop_modules(),
        Config {
            ipl_lle: true,
            ipl: Some(vec![0; IPL_BYTES]),
            sideload: None,
            perform_efb_copies: false,
            uart_escape: false,
        },
    );
    system.launch_hle_executable(Address(0x8000_3100));
    system
}

fn boot_state(id: [u8; 6], revision: u8, epoch: u64) -> AuthenticatedBootState {
    AuthenticatedBootState {
        boot_epoch: epoch,
        status: MachineBootStatus::Committed,
        fault: MachineBootFault::None,
        identity: Some(AuthenticatedBootIdentity {
            identifier: id,
            revision,
            disc_number: 0,
            format: MachineDiscFormat::RawIso,
            logical_bytes: 1_459_978_240,
        }),
    }
}

fn presentation(
    completion_cycle: u64,
    render_sequence: u64,
    serial: u64,
    generation: u32,
    pair_epoch: u32,
) -> MachineXfbViEvidenceV1 {
    MachineXfbViEvidenceV1 {
        xfb_completion_cycle: EvidenceU64::new(completion_cycle - 2),
        vi_selection_cycle: EvidenceU64::new(completion_cycle - 1),
        render_completion_cycle: EvidenceU64::new(completion_cycle),
        render_sequence: EvidenceU64::new(render_sequence),
        presentation_serial: EvidenceU64::new(serial),
        xfb_generation: generation,
        selected_row: 0,
        mode_raw: ViPresentationMode::SingleField as u32,
        parity_raw: ViFieldParity::Top as u32,
        pair_epoch,
        xfb_width: 640,
        xfb_height: 480,
        xfb_stride: 1_280,
        output_width: 640,
        output_height: 480,
        field_stride_bytes: 1_280,
        field_height: 480,
        row_repeat: 1,
        presentation_status_raw: RenderPresentationStatus::Presented as u32,
        presentation_width: 640,
        presentation_height: 480,
        flags: MACHINE_XFB_VI_PAIR_COMPLETING,
    }
}

fn physical_offset(effective: u32) -> usize {
    effective.checked_sub(0x8000_0000).unwrap() as usize
}

fn put(system: &mut System, effective: u32, bytes: &[u8]) {
    let start = physical_offset(effective);
    let end = start + bytes.len();
    system.mem.ram_mut()[start..end].copy_from_slice(bytes);
}

fn put_u16(system: &mut System, effective: u32, value: u16) {
    put(system, effective, &value.to_be_bytes());
}

fn put_u32(system: &mut System, effective: u32, value: u32) {
    put(system, effective, &value.to_be_bytes());
}

fn put_i32(system: &mut System, effective: u32, value: i32) {
    put(system, effective, &value.to_be_bytes());
}

fn seed_wario_baseline(system: &mut System) {
    put_u32(system, 0x8029_5ed0, 0x63);
    put_i32(system, 0x8029_58ac, 0);
    put_u32(system, 0x802f_6860, RUNTIME);
    put_u16(system, RUNTIME + 0x4b160, 0);
    put_u32(system, RUNTIME + 0x4b178, PLAYER);
    put_i32(system, PLAYER + 0x1230, 0);
}

fn select_wario(integration: &mut GameFidelityIntegration) {
    integration.accept_authenticated_boot(boot_state(*b"GZWE01", 0, 7));
    assert_eq!(integration.phase(), Some(ProbePhase::Unarmed));
}

fn arm_wario(integration: &mut GameFidelityIntegration, system: &mut System) {
    seed_wario_baseline(system);
    integration.accept_authenticated_vi(system, presentation(100, 10, 20, 2, 1));
    assert_eq!(integration.phase(), Some(ProbePhase::Baseline));
    assert_eq!(integration.requested_buttons(), 0x0100);
    assert_eq!(
        integration.requested_controller_state(),
        Some(ControllerInputState {
            buttons: 0x0100,
            stick_x: 0x80,
            stick_y: 0x80,
            c_stick_x: 0x80,
            c_stick_y: 0x80,
            trigger_l: 0,
            trigger_r: 0,
            analog_a: u8::MAX,
            analog_b: 0,
        }),
    );
}

fn direct_press(system: &mut System, sequence: u64, buttons: u16) -> ControllerPublication {
    let sample = ControllerInputSample::new(
        sequence,
        ControllerInputState {
            buttons,
            stick_x: if buttons & 0x0001 != 0 { 0x01 } else { 0x80 },
            stick_y: 0x80,
            c_stick_x: 0x80,
            c_stick_y: 0x80,
            trigger_l: 0,
            trigger_r: 0,
            analog_a: if buttons & 0x0100 != 0 { u8::MAX } else { 0 },
            analog_b: if buttons & 0x0200 != 0 { u8::MAX } else { 0 },
        },
    )
    .unwrap();
    system.serial.publish_controller_input(sample).unwrap();
    system.serial.buffer[0] = 0x40;
    let transfer = system
        .serial
        .write_comm_control_at(CommControl::from_bits(1), 110)
        .unwrap()
        .started
        .unwrap();
    let mut deadlines = MachineEventDeadlines::default();
    system.serial.publish_deadlines(&mut deadlines);
    let completion = system
        .serial
        .service_next_due(
            ViSerialTiming {
                display_enabled: true,
                anchor_cycle: 0,
                anchor_half_line: 0,
                cycles_into_half_line: 0,
                cycles_per_half_line: 100,
                odd_half_lines: 20,
                total_half_lines: 40,
            },
            transfer.completion_cycle,
            &mut deadlines,
        )
        .unwrap()
        .unwrap();
    let SerialServiceResult::Transfer(completion) = completion else {
        panic!("a direct poll must complete as an SI transfer");
    };
    completion.publication.unwrap()
}

#[test]
fn authenticated_boot_is_the_only_selector_and_unarmed_retries_only_on_presented_vi() {
    let mut integration = GameFidelityIntegration::default();
    let mut system = test_system();
    put(&mut system, 0x8000_0000, b"GZWE01\0\0");

    integration.sample_after_dispatch(&mut system, 50);
    assert_eq!(integration.phase(), None);
    assert!(integration.snapshot().is_none());

    integration.accept_authenticated_boot(AuthenticatedBootState {
        boot_epoch: 7,
        status: MachineBootStatus::Loading,
        fault: MachineBootFault::None,
        identity: None,
    });
    assert_eq!(integration.phase(), None);

    select_wario(&mut integration);
    integration.sample_after_dispatch(&mut system, 60);
    assert_eq!(integration.phase(), Some(ProbePhase::Unarmed));

    integration.accept_authenticated_vi(&mut system, presentation(70, 1, 1, 1, 1));
    assert_eq!(integration.phase(), Some(ProbePhase::Unarmed));
    assert_eq!(
        integration.probe().unwrap().record().failure(),
        FailureCode::None,
        "a pre-milestone miss must poison only the discarded clone",
    );

    seed_wario_baseline(&mut system);
    integration.accept_authenticated_vi(&mut system, presentation(100, 2, 2, 2, 2));
    assert_eq!(integration.phase(), Some(ProbePhase::Baseline));
    assert_eq!(integration.requested_buttons(), 0x0100);

    let mut unsupported = GameFidelityIntegration::default();
    unsupported.accept_authenticated_boot(boot_state(*b"GMBE8P", 0, 8));
    assert_eq!(unsupported.phase(), None);
    assert!(unsupported.snapshot().is_none());

    let mut identity_drift = GameFidelityIntegration::default();
    select_wario(&mut identity_drift);
    identity_drift.accept_authenticated_boot(boot_state(*b"GLME01", 0, 7));
    assert_eq!(identity_drift.phase(), Some(ProbePhase::Failed));
    assert_eq!(
        identity_drift.probe().unwrap().record().failure(),
        FailureCode::UnsupportedIdentity,
    );
}

#[test]
fn probe_mem1_uses_observational_translation_without_mmu_or_memory_side_effects() {
    let mut system = test_system();
    put_u32(&mut system, 0x8029_5ed0, 0x1122_3344);
    let mmu_before = system.mmu.clone();
    let ram_before = system.mem.ram().to_vec();
    let mut bytes = [0; 4];
    {
        let memory = ProbeMem1::new(&mut system);
        memory.read_exact(0x8029_5ed0, &mut bytes).unwrap();
    }
    assert_eq!(bytes, 0x1122_3344_u32.to_be_bytes());
    assert_eq!(system.mmu, mmu_before);
    assert_eq!(system.mem.ram(), ram_before);

    let mapping = system
        .translate_data_range_mmu(Address(0x8029_5ed0), 4, false, TranslationEffect::Probe)
        .unwrap();
    assert_eq!(mapping.physical, 0x0029_5ed0);
}

#[test]
fn typed_si_receipt_and_authenticated_vi_complete_a_stable_opaque_snapshot() {
    let mut integration = GameFidelityIntegration::default();
    let mut system = test_system();
    select_wario(&mut integration);
    arm_wario(&mut integration, &mut system);

    let first_snapshot = integration.snapshot().unwrap();
    let snapshot_pointer = first_snapshot.as_ptr();
    let first_bytes = *first_snapshot;
    assert_eq!(snapshot_pointer as usize % 8, 0);

    let publication = direct_press(&mut system, 1, 0x0100);
    assert_eq!(integration.requested_buttons(), 0x0100);
    integration.accept_authenticated_si_publication(publication);
    assert_eq!(integration.phase(), Some(ProbePhase::Published));
    assert_eq!(integration.requested_buttons(), 0);
    assert_eq!(integration.requested_controller_state(), None);
    assert_eq!(
        unsafe { std::slice::from_raw_parts(snapshot_pointer, first_bytes.len()) },
        first_bytes,
        "machine mutation must not rewrite the stable snapshot",
    );

    put_u16(&mut system, RUNTIME + 0x4b160, 0x0100);
    integration.sample_after_dispatch(&mut system, publication.observed_cycle + 1);
    assert_eq!(integration.phase(), Some(ProbePhase::Received));
    integration.sample_after_dispatch(&mut system, publication.observed_cycle + 1);
    assert_eq!(
        integration.phase(),
        Some(ProbePhase::Received),
        "an equal-cycle zero-work boundary is not yet a post sample",
    );
    integration.sample_after_dispatch(&mut system, publication.observed_cycle + 2);
    assert_eq!(
        integration.phase(),
        Some(ProbePhase::Received),
        "holding A with an unchanged result must keep waiting for the causal post state",
    );
    put_u16(&mut system, RUNTIME + 0x4b160, 0);
    put_i32(&mut system, PLAYER + 0x1230, 1);
    integration.sample_after_dispatch(&mut system, publication.observed_cycle + 3);
    assert_eq!(integration.phase(), Some(ProbePhase::Posted));
    integration.accept_authenticated_vi(
        &mut system,
        presentation(publication.observed_cycle + 3, 11, 21, 2, 2),
    );
    assert_eq!(
        integration.phase(),
        Some(ProbePhase::Posted),
        "a same-cycle Presented completion must wait for a later frame",
    );
    integration.accept_authenticated_vi(
        &mut system,
        presentation(publication.observed_cycle + 4, 11, 21, 1, 2),
    );
    assert_eq!(
        integration.phase(),
        Some(ProbePhase::Posted),
        "presenting an older retained XFB is valid but not distinct evidence",
    );
    integration.accept_authenticated_vi(
        &mut system,
        presentation(publication.observed_cycle + 5, 12, 22, 3, 2),
    );
    assert_eq!(integration.phase(), Some(ProbePhase::Accepted));

    let later_snapshot = integration.snapshot().unwrap();
    assert_eq!(later_snapshot.as_ptr(), snapshot_pointer);
    assert_ne!(*later_snapshot, first_bytes);
}

#[test]
fn post_arm_sequence_and_lifetime_drift_are_sticky_failures() {
    let mut sequence = GameFidelityIntegration::default();
    let mut sequence_system = test_system();
    select_wario(&mut sequence);
    arm_wario(&mut sequence, &mut sequence_system);
    let first = direct_press(&mut sequence_system, 1, 0x0100);
    sequence.accept_authenticated_si_publication(first);
    let _second = direct_press(&mut sequence_system, 2, 0);
    sequence.sample_after_dispatch(&mut sequence_system, first.observed_cycle + 1);
    assert_eq!(sequence.phase(), Some(ProbePhase::Failed));
    assert_eq!(
        sequence.probe().unwrap().record().failure(),
        FailureCode::Sequence,
    );
    let failed_snapshot = sequence.snapshot().unwrap();
    assert_eq!(
        u32::from_le_bytes([
            failed_snapshot[12],
            failed_snapshot[13],
            failed_snapshot[14],
            failed_snapshot[15],
        ]),
        ProbePhase::Failed as u32,
    );
    assert_eq!(
        u32::from_le_bytes([
            failed_snapshot[20],
            failed_snapshot[21],
            failed_snapshot[22],
            failed_snapshot[23],
        ]),
        FailureCode::Sequence as u32,
    );

    let mut lifetime = GameFidelityIntegration::default();
    let mut lifetime_system = test_system();
    select_wario(&mut lifetime);
    arm_wario(&mut lifetime, &mut lifetime_system);
    let publication = direct_press(&mut lifetime_system, 1, 0x0100);
    lifetime.accept_authenticated_si_publication(publication);
    put_u16(&mut lifetime_system, RUNTIME + 0x4b160, 0x0100);
    lifetime.sample_after_dispatch(&mut lifetime_system, publication.observed_cycle + 1);
    assert_eq!(lifetime.phase(), Some(ProbePhase::Received));
    const RELOCATED_RUNTIME: u32 = 0x8030_0000;
    const RELOCATED_PLAYER: u32 = 0x8036_0000;
    put_u32(&mut lifetime_system, 0x802f_6860, RELOCATED_RUNTIME);
    put_u16(&mut lifetime_system, RELOCATED_RUNTIME + 0x4b160, 0);
    put_u32(
        &mut lifetime_system,
        RELOCATED_RUNTIME + 0x4b178,
        RELOCATED_PLAYER,
    );
    put_i32(&mut lifetime_system, RELOCATED_PLAYER + 0x1230, 0);
    lifetime.sample_after_dispatch(&mut lifetime_system, publication.observed_cycle + 2);
    assert_eq!(lifetime.phase(), Some(ProbePhase::Failed));
    assert_eq!(
        lifetime.probe().unwrap().record().failure(),
        FailureCode::Lifetime,
    );
}

#[test]
fn browser_machine_does_not_select_from_mutable_mem1_header() {
    let mut machine = BrowserMachine::from_system(test_system()).unwrap();
    put(&mut machine.system, 0x8000_0000, b"GZWE01\0\0");
    machine.sample_game_fidelity_after_dispatch();
    assert_eq!(machine.game_fidelity_phase(), ProbePhase::Unarmed as u32);
    assert_eq!(machine.game_fidelity_requested_buttons(), 0);
    assert_eq!(machine.game_fidelity_requested_stick_xy_cxy(), 0);
    assert_eq!(machine.game_fidelity_requested_trigger_lrab(), 0);
    assert!(machine.game_fidelity_snapshot().is_none());
}

#[test]
fn browser_machine_packs_the_rust_authored_wario_controller_lanes_exactly() {
    let mut machine = BrowserMachine::from_system(test_system()).unwrap();
    machine
        .game_fidelity
        .accept_authenticated_boot(boot_state(*b"GZWE01", 0, 7));
    seed_wario_baseline(&mut machine.system);
    machine
        .game_fidelity
        .accept_authenticated_vi(&mut machine.system, presentation(100, 10, 20, 2, 1));
    assert_eq!(machine.game_fidelity_phase(), ProbePhase::Baseline as u32);
    assert_eq!(machine.game_fidelity_requested_buttons(), 0x0100);
    assert_eq!(machine.game_fidelity_requested_stick_xy_cxy(), 0x8080_8080);
    assert_eq!(machine.game_fidelity_requested_trigger_lrab(), 0x00ff_0000);
}

#[test]
fn browser_machine_packs_the_rust_authored_left_stick_lanes_exactly() {
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
    assert_eq!(super::pack_game_fidelity_stick_xy_cxy(left), 0x8080_8001);
    assert_eq!(super::pack_game_fidelity_trigger_lrab(left), 0);
}
