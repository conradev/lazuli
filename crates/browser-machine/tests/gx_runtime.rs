#[path = "../src/gx_runtime.rs"]
mod gx_runtime;

use gx_runtime::{
    GxEfbPeekProgress, GxRuntimeError, GxRuntimeEvent, GxRuntimeLimits, GxTerminalSupplement,
    ResidentGxRuntime,
};
use lazuli::system::gx::resident_fifo::{BarrierClass, EfbPeekRequest, GxMemory, MemoryError};
use lazuli::system::gx::resident_texture::{TextureCopyReference, materialized_texture_hash};
use lzgx_packet::{PacketVersion, TerminalKind, inspect_envelope};

#[derive(Debug)]
struct TestMemory {
    bytes: Vec<u8>,
}

impl TestMemory {
    fn new(length: usize) -> Self {
        Self {
            bytes: vec![0; length],
        }
    }
}

impl GxMemory for TestMemory {
    fn read_exact(&mut self, address: u32, destination: &mut [u8]) -> Result<(), MemoryError> {
        let start = usize::try_from(address).map_err(|_| MemoryError::OutOfBounds)?;
        let end = start
            .checked_add(destination.len())
            .ok_or(MemoryError::OutOfBounds)?;
        let source = self.bytes.get(start..end).ok_or(MemoryError::Unmapped)?;
        destination.copy_from_slice(source);
        Ok(())
    }
}

fn cp(register: u8, value: u32) -> Vec<u8> {
    let mut command = vec![0x08, register];
    command.extend_from_slice(&value.to_be_bytes());
    command
}

fn bp(register: u8, value: u32) -> Vec<u8> {
    let mut command = vec![0x61];
    command.extend_from_slice(&(u32::from(register) << 24 | value & 0x00ff_ffff).to_be_bytes());
    command
}

fn xf(start: u16, values: &[u32]) -> Vec<u8> {
    assert!(!values.is_empty() && values.len() <= 16);
    let header = ((values.len() as u32 - 1) << 16) | u32::from(start);
    let mut command = vec![0x10];
    command.extend_from_slice(&header.to_be_bytes());
    for value in values {
        command.extend_from_slice(&value.to_be_bytes());
    }
    command
}

fn xf_f32(start: u16, values: &[f32]) -> Vec<u8> {
    xf(
        start,
        &values
            .iter()
            .map(|value| value.to_bits())
            .collect::<Vec<_>>(),
    )
}

fn base_state(projection_type: u32) -> Vec<u8> {
    let mut stream = xf_f32(
        0,
        &[1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
    );
    stream.extend(xf_f32(0x400, &[1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0]));
    stream.extend(xf(0x100a, &[0, 0, u32::MAX, u32::MAX, 0, 0, 0, 0]));
    stream.extend(xf_f32(0x101a, &[320.0, -264.0, 1.0, 320.0, 264.0, 0.0]));
    stream.extend(xf_f32(0x1020, &[1.0, 0.0, 1.0, 0.0, 1.0, 0.0]));
    stream.extend(xf(0x1026, &[projection_type]));
    stream
}

fn triangle(projection_type: u32, z: f32) -> Vec<u8> {
    triangle_positions(
        projection_type,
        [[-0.5, -0.5, z], [0.5, -0.5, z], [0.0, 0.5, z]],
    )
}

fn triangle_positions(projection_type: u32, positions: [[f32; 3]; 3]) -> Vec<u8> {
    let mut stream = base_state(projection_type);
    stream.extend(cp(0x50, 1 << 9));
    stream.extend(cp(0x70, 1 | (4 << 1)));
    stream.push(0x90);
    stream.extend(3u16.to_be_bytes());
    for position in positions {
        for component in position {
            stream.extend(component.to_bits().to_be_bytes());
        }
    }
    stream
}

fn xfb_terminal(destination: u32) -> Vec<u8> {
    let mut stream = bp(0x49, 0);
    stream.extend(bp(0x4a, 3 | (3 << 10)));
    stream.extend(bp(0x4b, destination >> 5));
    stream.extend(bp(0x4d, 32 >> 5));
    stream.extend(bp(0x4e, 256));
    stream.extend(bp(0x52, 0x4000));
    stream
}

fn texture_terminal(source_x: u32, destination: u32, command: u32) -> Vec<u8> {
    let mut stream = bp(0x49, source_x);
    stream.extend(bp(0x4a, 7 | (7 << 10)));
    stream.extend(bp(0x4b, destination >> 5));
    stream.extend(bp(0x4d, 32 >> 5));
    stream.extend(bp(0x4e, 256));
    stream.extend(bp(0x52, command & !0x4000));
    stream
}

fn textured_triangle(address: u32, mode0: u32, mode1: u32, manual_tmem: bool) -> Vec<u8> {
    let mut stream = base_state(1);
    stream.extend(xf(0x103f, &[1]));
    stream.extend(bp(0x28, 1 << 6));
    stream.extend(bp(0x80, mode0));
    stream.extend(bp(0x84, mode1));
    stream.extend(bp(0x88, 7 | (7 << 10)));
    stream.extend(bp(
        0x8c,
        if manual_tmem {
            0x0020_0000 | 4
        } else {
            (3 << 15) | (3 << 18)
        },
    ));
    stream.extend(bp(0x90, 0x1000 | (3 << 15) | (3 << 18)));
    stream.extend(bp(0x94, address >> 5));
    stream.extend(cp(0x50, 1 << 9));
    stream.extend(cp(0x70, 1 | (4 << 1)));
    stream.push(0x90);
    stream.extend(3u16.to_be_bytes());
    for position in [
        [-0.5_f32, -0.5, -0.5],
        [0.5_f32, -0.5, -0.5],
        [0.0_f32, 0.5, -0.5],
    ] {
        for component in position {
            stream.extend(component.to_bits().to_be_bytes());
        }
    }
    stream
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn take_terminals(
    progress: gx_runtime::GxRuntimeProgress,
) -> (
    Option<gx_runtime::GxProgressIdentity>,
    Vec<gx_runtime::GxTerminalHandoff>,
) {
    let (identity, _, events) = progress.into_parts();
    let terminals = events
        .into_iter()
        .filter_map(|event| match event {
            GxRuntimeEvent::Terminal(handoff) => Some(handoff),
            GxRuntimeEvent::PeBpLoad(_) => None,
        })
        .collect();
    (identity, terminals)
}

#[test]
fn resident_gx_runtime_constructs_with_bounded_defaults() {
    let limits = GxRuntimeLimits::default();
    let runtime = ResidentGxRuntime::try_new(limits).unwrap();
    assert_eq!(runtime.limits(), limits);
    assert_eq!(runtime.stats(), gx_runtime::GxRuntimeStats::default());
    assert_eq!(runtime.decoder().pending_barrier(), None);
    assert_eq!(runtime.pending_bytes().unwrap(), 0);
    assert!(!runtime.is_poisoned());
}

#[test]
fn draw_can_span_batches_and_handoff_capacity_stays_charged_until_acceptance() {
    let mut runtime = ResidentGxRuntime::try_new(GxRuntimeLimits::default()).unwrap();
    let mut memory = TestMemory::new(1);
    let first = runtime.append(&triangle(1, -0.5), &mut memory, 10).unwrap();
    assert!(first.events().is_empty());
    assert!(runtime.pending_bytes().unwrap() >= 3 * 144);

    let second = runtime
        .append(&xfb_terminal(0x1000), &mut memory, 20)
        .unwrap();
    let mut handoff = None;
    let mut bp_effects = 0;
    let progress_charge = second.pending_charge();
    let (progress_identity, _, events) = second.into_parts();
    for event in events {
        match event {
            GxRuntimeEvent::PeBpLoad(_) => bp_effects += 1,
            GxRuntimeEvent::Terminal(value) => handoff = Some(value),
        }
    }
    assert_eq!(bp_effects, 6);
    let handoff = handoff.unwrap();
    let info = inspect_envelope(handoff.packet()).unwrap();
    assert_eq!(info.version, PacketVersion::V4);
    assert_eq!(info.terminal.kind, TerminalKind::XfbCopy);
    assert_eq!(info.draw_count, 1);
    assert_eq!(info.total_vertex_count, 3);
    assert_eq!(
        runtime.pending_bytes().unwrap(),
        handoff.pending_charge() + progress_charge
    );
    assert_eq!(
        runtime.resume(&mut memory, 21).unwrap_err(),
        GxRuntimeError::OutstandingHandoffs
    );
    assert_eq!(
        runtime.reset().unwrap_err(),
        GxRuntimeError::OutstandingHandoffs
    );

    let (identity, packet, _) = handoff.into_parts();
    assert_eq!(
        packet.capacity() + progress_charge,
        runtime.pending_bytes().unwrap()
    );
    runtime.accept_terminal_handoff(identity).unwrap();
    assert_eq!(runtime.pending_bytes().unwrap(), progress_charge);
    runtime.accept_progress(progress_identity.unwrap()).unwrap();
    assert_eq!(runtime.pending_bytes().unwrap(), 0);
}

#[test]
fn failed_renderer_admission_poison_is_explicitly_resettable_after_outputs_are_discarded() {
    let limits = GxRuntimeLimits::default();
    let mut runtime = ResidentGxRuntime::try_new(limits).unwrap();
    let mut memory = TestMemory::new(1);
    let progress = runtime
        .append(&xfb_terminal(0x1000), &mut memory, 25)
        .unwrap();
    let (_, _, events) = progress.into_parts();
    let terminal = events
        .into_iter()
        .find_map(|event| match event {
            GxRuntimeEvent::Terminal(terminal) => Some(terminal),
            GxRuntimeEvent::PeBpLoad(_) => None,
        })
        .unwrap();
    let (identity, packet, _) = terminal.into_parts();
    assert_eq!(
        runtime.fail_terminal_handoff(identity),
        Err(GxRuntimeError::Poisoned)
    );
    assert!(runtime.is_poisoned());
    drop(packet);
    runtime.reset().unwrap();
    assert_eq!(runtime.limits(), limits);
    assert_eq!(runtime.pending_bytes().unwrap(), 0);
    assert!(!runtime.is_poisoned());
}

#[test]
fn multiple_nonblocking_terminals_preserve_order_and_require_fifo_acceptance() {
    let mut runtime = ResidentGxRuntime::try_new(GxRuntimeLimits::default()).unwrap();
    let mut memory = TestMemory::new(1);
    let mut stream = bp(0xfe, 0x0000_00ff);
    stream.extend(bp(0x41, 0x1234));
    stream.extend(bp(0x47, 0xabcd));
    stream.extend(bp(0x48, 0x4567));
    stream.extend(xfb_terminal(0x1000));
    stream.extend(xfb_terminal(0x2000));
    let progress = runtime.append(&stream, &mut memory, 77).unwrap();
    let effects: Vec<(u8, u32)> = progress
        .events()
        .iter()
        .filter_map(|event| match event {
            GxRuntimeEvent::PeBpLoad(effect) => Some((effect.register, effect.value)),
            GxRuntimeEvent::Terminal(_) => None,
        })
        .collect();
    assert_eq!(
        &effects[..4],
        &[(0xfe, 0xff), (0x41, 0x34), (0x47, 0xabcd), (0x48, 0x4567)]
    );
    let (progress_identity, _, events) = progress.into_parts();
    let mut terminals = events.into_iter().filter_map(|event| match event {
        GxRuntimeEvent::Terminal(handoff) => Some(handoff),
        GxRuntimeEvent::PeBpLoad(_) => None,
    });
    let first = terminals.next().unwrap();
    let second = terminals.next().unwrap();
    assert!(terminals.next().is_none());
    assert_eq!(first.metadata().terminal.sequence, 1);
    assert_eq!(second.metadata().terminal.sequence, 2);
    assert_eq!(
        inspect_envelope(first.packet())
            .unwrap()
            .terminal
            .generation,
        1
    );
    assert_eq!(
        inspect_envelope(second.packet())
            .unwrap()
            .terminal
            .generation,
        2
    );
    let (first_id, _, _) = first.into_parts();
    let (second_id, _, _) = second.into_parts();
    assert_eq!(
        runtime.accept_terminal_handoff(second_id),
        Err(GxRuntimeError::HandoffMismatch)
    );
    runtime.accept_terminal_handoff(first_id).unwrap();
    runtime.accept_terminal_handoff(second_id).unwrap();
    runtime.accept_progress(progress_identity.unwrap()).unwrap();
}

#[test]
fn clipped_noop_and_reserved_layout_emit_canonical_legacy_texture_packets() {
    let mut memory = TestMemory::new(1);
    let mut no_op = ResidentGxRuntime::try_new(GxRuntimeLimits::default()).unwrap();
    let mut stream = triangle(1, -0.5);
    stream.extend(texture_terminal(700, 0x1000, 0));
    let (progress_identity, mut terminals) =
        take_terminals(no_op.append(&stream, &mut memory, 1).unwrap());
    let terminal = terminals.pop().unwrap();
    let info = inspect_envelope(terminal.packet()).unwrap();
    assert_eq!(info.terminal.kind, TerminalKind::TextureCopy);
    assert_eq!(
        (info.terminal.output_width, info.terminal.output_height),
        (0, 0)
    );
    assert_eq!(info.terminal.stride, 0);
    assert!(!info.terminal.texture_copy_layout_v1);
    assert_eq!(info.draw_count, 1);
    assert_eq!(
        terminal.metadata().supplement,
        GxTerminalSupplement::TextureCopy { layout: None }
    );
    assert_eq!(no_op.pending_barrier(), None);
    let (identity, _, _) = terminal.into_parts();
    no_op.accept_terminal_handoff(identity).unwrap();
    no_op.accept_progress(progress_identity.unwrap()).unwrap();

    let mut reserved = ResidentGxRuntime::try_new(GxRuntimeLimits::default()).unwrap();
    let (progress_identity, mut terminals) = take_terminals(
        reserved
            .append(&texture_terminal(0, 0x1000, 0x58), &mut memory, 2)
            .unwrap(),
    );
    let terminal = terminals.pop().unwrap();
    let info = inspect_envelope(terminal.packet()).unwrap();
    assert_eq!(
        (info.terminal.output_width, info.terminal.output_height),
        (0, 0)
    );
    assert_eq!(info.terminal.stride, 0);
    assert!(!info.terminal.texture_copy_layout_v1);
    assert_eq!(
        reserved.pending_barrier(),
        Some((1, BarrierClass::TextureCopyReceipt))
    );
    let (identity, _, metadata) = terminal.into_parts();
    reserved.accept_terminal_handoff(identity).unwrap();
    reserved
        .accept_progress(progress_identity.unwrap())
        .unwrap();
    let progress = reserved
        .acknowledge_legacy_texture_copy(metadata.terminal.sequence, &mut memory, 3)
        .unwrap();
    assert_eq!(
        progress.status,
        lazuli::system::gx::resident_fifo::DecodeStatus::Drained
    );
}

#[test]
fn more_than_renderer_queue_depth_remains_owned_charged_and_lossless() {
    let mut runtime = ResidentGxRuntime::try_new(GxRuntimeLimits::default()).unwrap();
    let mut memory = TestMemory::new(1);
    let mut stream = Vec::new();
    for terminal in 0..10u32 {
        stream.extend(xfb_terminal(0x1000 + terminal * 0x1000));
    }
    let progress = runtime.append(&stream, &mut memory, 100).unwrap();
    let progress_charge = progress.pending_charge();
    let (progress_identity, _, events) = progress.into_parts();
    let mut terminal_parts = Vec::new();
    for event in events {
        if let GxRuntimeEvent::Terminal(terminal) = event {
            terminal_parts.push(terminal.into_parts());
        }
    }
    assert_eq!(terminal_parts.len(), 10);
    for (index, (_, packet, metadata)) in terminal_parts.iter().enumerate() {
        assert_eq!(metadata.terminal.sequence, index as u64 + 1);
        assert_eq!(
            inspect_envelope(packet).unwrap().terminal.generation,
            index as u32 + 1
        );
    }
    let all_packet_charge: usize = terminal_parts
        .iter()
        .map(|(_, packet, _)| packet.capacity())
        .sum();
    assert_eq!(
        runtime.pending_bytes().unwrap(),
        all_packet_charge + progress_charge
    );

    for (identity, _, _) in &terminal_parts[..8] {
        runtime.accept_terminal_handoff(*identity).unwrap();
    }
    runtime.accept_progress(progress_identity.unwrap()).unwrap();
    let retained_packet_charge: usize = terminal_parts[8..]
        .iter()
        .map(|(_, packet, _)| packet.capacity())
        .sum();
    assert_eq!(runtime.pending_bytes().unwrap(), retained_packet_charge);
    assert_eq!(
        runtime.append(&[], &mut memory, 101),
        Err(GxRuntimeError::OutstandingHandoffs)
    );
    for (identity, _, _) in &terminal_parts[8..] {
        runtime.accept_terminal_handoff(*identity).unwrap();
    }
    assert_eq!(runtime.pending_bytes().unwrap(), 0);
    assert!(!runtime.is_poisoned());
}

#[test]
fn tmem_preloads_are_materialized_at_each_draw_not_at_later_terminal_state() {
    let mut runtime = ResidentGxRuntime::try_new(GxRuntimeLimits::default()).unwrap();
    let mut memory = TestMemory::new(0x1000);
    memory.bytes[0x200..0x220].fill(0x11);
    memory.bytes[0x300..0x320].fill(0x22);
    let mut stream = bp(0x60, 0x200 >> 5);
    stream.extend(bp(0x61, 4));
    stream.extend(bp(0x63, 1));
    stream.extend(textured_triangle(0, 0, 0, true));
    stream.extend(bp(0x60, 0x300 >> 5));
    stream.extend(bp(0x61, 4));
    stream.extend(bp(0x63, 1));
    stream.extend(textured_triangle(0, 0, 0, true));
    stream.extend(xfb_terminal(0x800));
    let progress = runtime.append(&stream, &mut memory, 200).unwrap();
    let (progress_identity, mut terminals) = take_terminals(progress);
    let terminal = terminals.pop().unwrap();
    let packet = terminal.packet();
    let info = inspect_envelope(packet).unwrap();
    assert_eq!(info.draw_count, 2);
    assert_eq!(info.texture_count, 2);
    let draw_table = read_u32(packet, 0x1c) as usize;
    assert_eq!(read_u32(packet, draw_table + 0x30), 0);
    assert_eq!(read_u32(packet, draw_table + 176 + 0x30), 1);
    let texture_table = read_u32(packet, 0x20) as usize;
    let pixel_base = read_u32(packet, 0x30) as usize;
    for (index, expected) in [(0usize, 0x11u8), (1usize, 0x22u8)] {
        let record = texture_table + index * 64;
        let relative = read_u32(packet, record + 0x08) as usize;
        assert_eq!(read_u32(packet, record + 0x0c), 8 * 8 * 4);
        assert_eq!(
            &packet[pixel_base + relative..pixel_base + relative + 4],
            &[expected; 4]
        );
    }
    let (terminal_identity, _, _) = terminal.into_parts();
    runtime.accept_terminal_handoff(terminal_identity).unwrap();
    runtime.accept_progress(progress_identity.unwrap()).unwrap();
}

#[test]
fn exact_evidence_negotiates_v4_v5_and_v6_without_host_policy() {
    let cases = [
        (triangle(1, -0.5), PacketVersion::V4, 1u16),
        (
            triangle_positions(1, [[2.0, -0.5, -0.5], [3.0, -0.5, -0.5], [2.5, 0.5, -0.5]]),
            PacketVersion::V5,
            2u16,
        ),
        (triangle(0, 0.0), PacketVersion::V6, 6u16),
    ];
    for (mut stream, expected_version, expected_flags) in cases {
        stream.extend(xfb_terminal(0x1000));
        let mut runtime = ResidentGxRuntime::try_new(GxRuntimeLimits::default()).unwrap();
        let mut memory = TestMemory::new(1);
        let (progress_identity, mut terminals) =
            take_terminals(runtime.append(&stream, &mut memory, 300).unwrap());
        let terminal = terminals.pop().unwrap();
        let packet = terminal.packet();
        assert_eq!(inspect_envelope(packet).unwrap().version, expected_version);
        let draw_table = usize::try_from(read_u32(packet, 0x1c)).unwrap();
        assert_eq!(
            u16::from_le_bytes(packet[draw_table + 2..draw_table + 4].try_into().unwrap()),
            expected_flags
        );
        let (terminal_identity, _, _) = terminal.into_parts();
        runtime.accept_terminal_handoff(terminal_identity).unwrap();
        runtime.accept_progress(progress_identity.unwrap()).unwrap();
    }
}

#[test]
fn genuine_referenced_mip_chain_negotiates_v7_and_keeps_all_levels() {
    let mut runtime = ResidentGxRuntime::try_new(GxRuntimeLimits::default()).unwrap();
    let mut memory = TestMemory::new(0x1000);
    memory.bytes[0x100..0x120].fill(0x11);
    memory.bytes[0x120..0x140].fill(0x22);
    let mut stream = textured_triangle(0x100, 1 << 5, 0x10 << 8, false);
    stream.extend(xfb_terminal(0x800));
    let (progress_identity, mut terminals) =
        take_terminals(runtime.append(&stream, &mut memory, 400).unwrap());
    let terminal = terminals.pop().unwrap();
    let packet = terminal.packet();
    let info = inspect_envelope(packet).unwrap();
    assert_eq!(info.version, PacketVersion::V7);
    assert_eq!(info.texture_count, 1);
    let texture_table = usize::try_from(read_u32(packet, 0x20)).unwrap();
    assert_eq!(
        read_u32(packet, texture_table + 0x0c),
        8 * 8 * 4 + 4 * 4 * 4
    );
    assert_eq!(read_u32(packet, texture_table + 0x24), 2);
    let key_base = usize::try_from(read_u32(packet, 0x2c)).unwrap();
    let key_offset = usize::try_from(read_u32(packet, texture_table)).unwrap();
    let key_len = usize::try_from(read_u32(packet, texture_table + 4)).unwrap();
    let key = std::str::from_utf8(&packet[key_base + key_offset..key_base + key_offset + key_len])
        .unwrap();
    assert!(key.contains("~LZGX7:"));
    let (terminal_identity, _, _) = terminal.into_parts();
    runtime.accept_terminal_handoff(terminal_identity).unwrap();
    runtime.accept_progress(progress_identity.unwrap()).unwrap();
}

#[test]
fn texture_receipt_is_hashed_recorded_then_reused_as_a_zero_payload_reference() {
    let mut runtime = ResidentGxRuntime::try_new(GxRuntimeLimits::default()).unwrap();
    let mut memory = TestMemory::new(0x4000);
    let (progress_identity, mut terminals) = take_terminals(
        runtime
            .append(&texture_terminal(0, 0x1000, 0), &mut memory, 500)
            .unwrap(),
    );
    let terminal = terminals.pop().unwrap();
    let metadata = terminal.metadata();
    let GxTerminalSupplement::TextureCopy {
        layout: Some(layout),
    } = metadata.supplement
    else {
        panic!("valid texture copy did not expose its physical layout");
    };
    let compact = vec![0x11; usize::try_from(layout.byte_length).unwrap()];
    memory.bytes[0x1000..0x1000 + compact.len()].copy_from_slice(&compact);
    let reference = TextureCopyReference {
        destination: metadata.terminal.destination,
        generation: metadata.terminal.generation,
        width: metadata.terminal.output_width,
        height: metadata.terminal.output_height,
        format: layout.base_format,
        stride: metadata.terminal.stride,
        row_bytes: layout.row_bytes,
        row_count: layout.row_count,
        materialized_hash: materialized_texture_hash(&compact),
    };
    let (terminal_identity, _, _) = terminal.into_parts();
    runtime.accept_terminal_handoff(terminal_identity).unwrap();
    runtime.accept_progress(progress_identity.unwrap()).unwrap();
    let resumed = runtime
        .acknowledge_texture_copy(reference, &compact, &mut memory, 501)
        .unwrap();
    assert!(resumed.events().is_empty());
    assert_eq!(runtime.pending_barrier(), None);

    let mut stream = textured_triangle(0x1000, 0, 0, false);
    stream.extend(xfb_terminal(0x2000));
    let (progress_identity, mut terminals) =
        take_terminals(runtime.append(&stream, &mut memory, 502).unwrap());
    let terminal = terminals.pop().unwrap();
    let packet = terminal.packet();
    let texture_table = usize::try_from(read_u32(packet, 0x20)).unwrap();
    assert_eq!(read_u32(packet, texture_table + 0x0c), 0);
    assert_eq!(read_u32(packet, texture_table + 0x14), 1);
    assert_eq!(read_u32(packet, texture_table + 0x20), 0);
    let (terminal_identity, _, _) = terminal.into_parts();
    runtime.accept_terminal_handoff(terminal_identity).unwrap();
    runtime.accept_progress(progress_identity.unwrap()).unwrap();
}

#[test]
fn efb_peek_value_is_committed_before_the_rust_barrier_resumes() {
    let mut runtime = ResidentGxRuntime::try_new(GxRuntimeLimits::default()).unwrap();
    let mut memory = TestMemory::new(1);
    assert_eq!(
        runtime
            .request_efb_peek(EfbPeekRequest {
                physical_address: 0x0880_0000,
                alpha_read_mode: 0,
                earlier_renderer_terminal: false,
            })
            .unwrap(),
        GxEfbPeekProgress::ImmediateZero {
            combined_plane: true
        }
    );
    assert_eq!(
        runtime
            .request_efb_peek(EfbPeekRequest {
                physical_address: 0x0800_0000,
                alpha_read_mode: 0,
                earlier_renderer_terminal: true,
            })
            .unwrap(),
        GxEfbPeekProgress::YieldForEarlierTerminal
    );

    let physical = 0x0800_0000 | 0x0040_0000 | (23 << 12) | (17 << 2);
    let GxEfbPeekProgress::Terminal(terminal) = runtime
        .request_efb_peek(EfbPeekRequest {
            physical_address: physical,
            alpha_read_mode: 2,
            earlier_renderer_terminal: false,
        })
        .unwrap()
    else {
        panic!("valid EFB aperture request did not yield a terminal");
    };
    assert_eq!(
        runtime.pending_barrier(),
        Some((1, BarrierClass::EfbPeekReceipt))
    );
    let metadata = terminal.metadata();
    let (identity, _, _) = terminal.into_parts();
    runtime.accept_terminal_handoff(identity).unwrap();
    let mut committed = None;
    let progress = runtime
        .acknowledge_efb_peek(
            metadata.terminal.sequence,
            0x1234_abcd,
            |commit| {
                committed = Some(commit);
                Ok(())
            },
            &mut memory,
            503,
        )
        .unwrap();
    let commit = committed.unwrap();
    assert_eq!(commit.value, 0x1234_abcd);
    assert_eq!(commit.alpha_read_mode, 2);
    assert!(!commit.combined_plane);
    assert_eq!(metadata.terminal.destination, 1);
    assert!(progress.events().is_empty());
    assert_eq!(runtime.pending_barrier(), None);
}

#[test]
fn malformed_and_aggregate_bound_failures_poison_without_panicking() {
    let mut malformed = ResidentGxRuntime::try_new(GxRuntimeLimits::default()).unwrap();
    let mut memory = TestMemory::new(1);
    let error = malformed
        .append(&xf(0x1057, &[1, 2]), &mut memory, 600)
        .unwrap_err();
    assert!(matches!(error, GxRuntimeError::Decode(_)));
    assert!(malformed.is_poisoned());
    assert_eq!(
        malformed.append(&[], &mut memory, 601),
        Err(GxRuntimeError::Poisoned)
    );

    let tight_limits = GxRuntimeLimits {
        maximum_pending_bytes: 1024,
        maximum_packet_bytes: 1024,
        ..GxRuntimeLimits::default()
    };
    let mut bounded = ResidentGxRuntime::try_new(tight_limits).unwrap();
    let error = bounded
        .append(&triangle(1, -0.5), &mut memory, 602)
        .unwrap_err();
    assert!(matches!(error, GxRuntimeError::PendingByteLimit { .. }));
    assert!(bounded.is_poisoned());

    let draw_limits = GxRuntimeLimits {
        maximum_pending_draws: 1,
        ..GxRuntimeLimits::default()
    };
    let mut draw_bounded = ResidentGxRuntime::try_new(draw_limits).unwrap();
    let mut two_draws = triangle(1, -0.5);
    two_draws.extend(triangle(1, -0.5));
    let error = draw_bounded
        .append(&two_draws, &mut memory, 603)
        .unwrap_err();
    assert!(matches!(error, GxRuntimeError::PendingDrawLimit { .. }));
    assert!(draw_bounded.is_poisoned());
}
