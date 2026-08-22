extern crate std;

use alloc::vec;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;
use std::string::{String, ToString};

use super::*;

const ZERO_BINDING: TextureBinding = TextureBinding {
    texture: None,
    mode0: 0,
    mode1: 0,
};

fn copy_state(copy_command: u32) -> CopyState {
    CopyState {
        z_mode: 0x0001_0203,
        blend_mode: 0x0004_0506,
        pixel_control: 0x0007_0809,
        copy_command,
        clear_rgba: [0x11, 0x22, 0x33, 0x44],
        clear_depth: 0x000a_0b0c,
        copy_scale: 0x000d_0e0f,
        copy_filter: [0x0010_1112, 0x0013_1415],
    }
}

fn xfb_terminal() -> TerminalState {
    TerminalState {
        kind: TerminalKind::XfbCopy,
        texture_copy_layout_v1: false,
        source_x: 0,
        source_y: 0,
        source_width: 4,
        source_height: 4,
        output_width: 4,
        output_height: 4,
        destination: 0x0011_0000,
        stride: 16,
        generation: 31,
        clear: false,
        copy: copy_state(0x0000_4000),
    }
}

fn texture_terminal(layout: bool) -> TerminalState {
    TerminalState {
        kind: TerminalKind::TextureCopy,
        texture_copy_layout_v1: layout,
        source_x: 1,
        source_y: 2,
        source_width: 3,
        source_height: 4,
        output_width: if layout { 3 } else { 0 },
        output_height: if layout { 4 } else { 0 },
        destination: 0x0010_0000,
        stride: if layout { 32 } else { 0 },
        generation: 7,
        clear: true,
        copy: copy_state(0x0000_0800),
    }
}

fn peek_terminal() -> TerminalState {
    TerminalState {
        kind: TerminalKind::EfbPeek,
        texture_copy_layout_v1: false,
        source_x: 320,
        source_y: 240,
        source_width: 1,
        source_height: 1,
        output_width: 0,
        output_height: 0,
        destination: 0,
        stride: 2,
        generation: 11,
        clear: false,
        copy: CopyState::default(),
    }
}

fn tev_state(required_map: Option<u32>) -> [u8; TEV_STATE_BYTES as usize] {
    let mut state = [0; TEV_STATE_BYTES as usize];
    if let Some(map) = required_map {
        state[0..4].copy_from_slice(&1u32.to_le_bytes());
        state[4..8].copy_from_slice(&2u32.to_le_bytes());
        state[8..12].copy_from_slice(&((1 << 6) | map).to_le_bytes());
        state[448..452].copy_from_slice(&1u32.to_le_bytes());
    }
    state
}

fn empty_draw<'a>(
    vertices: &'a [u8],
    tev_state: &'a [u8; TEV_STATE_BYTES as usize],
) -> DrawInput<'a> {
    DrawInput {
        topology: 2,
        cull_mode: 0,
        vertices,
        tev_state,
        z_mode: 0,
        blend_mode: 0x18,
        alpha_test: 0x003f_0000,
        scissor_x: 0,
        scissor_y: 0,
        scissor_width: 4,
        scissor_height: 4,
        textures: [ZERO_BINDING; MAX_TEXTURES],
        fragment: FragmentState {
            viewport_half_width_bits: 0x43a0_0000,
            ..FragmentState::default()
        },
        evidence: DrawEvidence::None,
        indirect_tev: None,
    }
}

fn encode_case(name: &str) -> Vec<u8> {
    let vertices = vec![0; 3 * VERTEX_BYTES as usize];
    let no_tev = tev_state(None);
    let map0_tev = tev_state(Some(0));
    match name {
        "empty_terminal" => encode(&PacketInput {
            version: PacketVersion::V4,
            terminal: texture_terminal(false),
            draws: &[],
            textures: &[],
        })
        .unwrap(),
        "one_draw_texture" => {
            let pixels = [1, 2, 3, 4];
            let textures = [TextureInput {
                key: "tex-one",
                pixels: Some(&pixels),
                address: 0x0012_3000,
                generation: 9,
                width: 1,
                height: 1,
                mip_level_count: 1,
            }];
            let mut draw = empty_draw(&vertices, &map0_tev);
            draw.textures[0] = TextureBinding {
                texture: Some(0),
                mode0: 0x11,
                mode1: 0,
            };
            encode(&PacketInput {
                version: PacketVersion::V4,
                terminal: xfb_terminal(),
                draws: &[draw],
                textures: &textures,
            })
            .unwrap()
        }
        "exact_clip_v6" => {
            let position_bits = [
                0.0f32.to_bits(),
                0.0f32.to_bits(),
                (-0.5f32).to_bits(),
                1.0f32.to_bits(),
                2.0f32.to_bits(),
                0.0f32.to_bits(),
                (-0.5f32).to_bits(),
                1.0f32.to_bits(),
                0.0f32.to_bits(),
                1.0f32.to_bits(),
                (-0.5f32).to_bits(),
                1.0f32.to_bits(),
            ];
            let mut draw = empty_draw(&vertices, &no_tev);
            draw.evidence = DrawEvidence::Exact {
                required: true,
                input: ExactClipInput {
                    bp_gen_mode: 0,
                    bp_scissor_top_left: (342 << 12) | 342,
                    bp_scissor_bottom_right: ((342 + 639) << 12) | (342 + 527),
                    bp_scissor_offset: 171 | (171 << 10),
                    xf_clip_disable: 0,
                    viewport_bits: [
                        320.0f32.to_bits(),
                        (-264.0f32).to_bits(),
                        16_777_215.0f32.to_bits(),
                        342.0f32.to_bits(),
                        342.0f32.to_bits(),
                        0.0f32.to_bits(),
                    ],
                    position_bits: &position_bits,
                },
            };
            encode(&PacketInput {
                version: PacketVersion::V6,
                terminal: xfb_terminal(),
                draws: &[draw],
                textures: &[],
            })
            .unwrap()
        }
        "indirect_tev" => {
            let mut indirect_tev_state = no_tev;
            indirect_tev_state[448..452].copy_from_slice(&1u32.to_le_bytes());
            let pixels = [9, 8, 7, 6];
            let textures = [TextureInput {
                key: "iref-zero-map-zero",
                pixels: Some(&pixels),
                address: 0,
                generation: 0,
                width: 1,
                height: 1,
                mip_level_count: 1,
            }];
            let mut draw = empty_draw(&vertices, &indirect_tev_state);
            draw.textures[0] = TextureBinding {
                texture: Some(0),
                mode0: 0,
                mode1: 0,
            };
            let mut commands = [0; 16];
            commands[0] = 1 << 7;
            draw.indirect_tev = Some(IndirectTevState {
                encoding: INDIRECT_TEV_STATE_ENCODING_BP_WORDS_XF_V2,
                gen_mode: 1 << 16,
                matrices: [0; 9],
                imask: 0,
                commands,
                tex_scales: [0; 2],
                iref: 0,
                xf_num_tex_gens: 0,
            });
            encode(&PacketInput {
                version: PacketVersion::V4,
                terminal: xfb_terminal(),
                draws: &[draw],
                textures: &textures,
            })
            .unwrap()
        }
        "mip_v7" => {
            let mip_pixels = (0..72)
                .map(|index| (3 + index * 17) as u8)
                .collect::<Vec<_>>();
            let textures = [TextureInput {
                key: "npot-5x3",
                pixels: Some(&mip_pixels),
                address: 0x0012_3000,
                generation: 17,
                width: 5,
                height: 3,
                mip_level_count: 3,
            }];
            let mut draw = empty_draw(&vertices, &map0_tev);
            draw.textures[0] = TextureBinding {
                texture: Some(0),
                mode0: 0x0008_0051,
                mode1: 0x0000_2004,
            };
            encode(&PacketInput {
                version: PacketVersion::V7,
                terminal: xfb_terminal(),
                draws: &[draw],
                textures: &textures,
            })
            .unwrap()
        }
        "texture_copy" => encode(&PacketInput {
            version: PacketVersion::V4,
            terminal: texture_terminal(true),
            draws: &[],
            textures: &[],
        })
        .unwrap(),
        "xfb" => {
            let mut draw = empty_draw(&vertices, &no_tev);
            draw.evidence = DrawEvidence::PostCull(&[3]);
            encode(&PacketInput {
                version: PacketVersion::V4,
                terminal: xfb_terminal(),
                draws: &[draw],
                textures: &[],
            })
            .unwrap()
        }
        "efb_peek" => encode(&PacketInput {
            version: PacketVersion::V4,
            terminal: peek_terminal(),
            draws: &[],
            textures: &[],
        })
        .unwrap(),
        _ => panic!("unknown fixture {name}"),
    }
}

fn decode_hex(value: &str) -> Vec<u8> {
    assert!(value.len().is_multiple_of(2));
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let digit = |byte: u8| match byte {
                b'0'..=b'9' => byte - b'0',
                b'a'..=b'f' => byte - b'a' + 10,
                _ => panic!("invalid oracle hex"),
            };
            digit(pair[0]) << 4 | digit(pair[1])
        })
        .collect()
}

fn js_oracle_packets() -> BTreeMap<String, Vec<u8>> {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/js_oracle.mjs");
    let output = Command::new("node")
        .arg(script)
        .output()
        .expect("Node is required for the JS-to-Rust packet parity oracle");
    assert!(
        output.status.success(),
        "JS packet oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| {
            let (name, hex) = line.split_once('=').expect("name=hex oracle record");
            (name.to_string(), decode_hex(hex))
        })
        .collect()
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

#[test]
fn rust_encoder_is_byte_identical_to_all_js_transport_goldens() {
    let oracle = js_oracle_packets();
    let names = [
        ("empty_terminal", 160, 0x9613_a764_ac19_40e8),
        ("one_draw_texture", 1328, 0x2983_e317_520d_b09c),
        ("exact_clip_v6", 1328, 0x3398_ab1d_df1b_6fe8),
        ("indirect_tev", 1472, 0xf76b_3549_42cc_ac9f),
        ("mip_v7", 1424, 0xf147_8ec4_1960_d920),
        ("texture_copy", 160, 0x6791_a8da_95f3_54fa),
        ("xfb", 1248, 0xa2c9_3d10_b217_a101),
        ("efb_peek", 160, 0x3c1d_5b86_d597_4999),
    ];
    assert_eq!(oracle.len(), names.len());
    for (name, expected_len, expected_fnv) in names {
        let rust = encode_case(name);
        let js = oracle.get(name).expect("named JS golden");
        assert_eq!(js.len(), expected_len, "JS golden {name} changed length");
        assert_eq!(
            fnv1a64(js),
            expected_fnv,
            "JS golden {name} changed identity"
        );
        assert_eq!(rust, *js, "Rust packet differs from JS golden {name}");
        let info = inspect_envelope(&rust).unwrap();
        assert_eq!(info.packet_bytes as usize, rust.len());
    }
}

#[test]
fn checked_envelope_inspection_returns_typed_terminal_metadata() {
    let packet = encode_case("xfb");
    let info = inspect_envelope(&packet).unwrap();
    assert_eq!(info.version, PacketVersion::V4);
    assert_eq!(info.flags, 0);
    assert_eq!(info.draw_count, 1);
    assert_eq!(info.texture_count, 0);
    assert_eq!(info.total_vertex_count, 3);
    assert_eq!(info.terminal, xfb_terminal());
    validate_envelope(&packet).unwrap();

    let mut malformed = packet;
    malformed[0x10..0x14].copy_from_slice(&0u32.to_le_bytes());
    assert_eq!(
        inspect_envelope(&malformed),
        Err(PacketError::InvalidField("terminal kind"))
    );
}

#[test]
fn indirect_matrix_component_bits_do_not_claim_a_texture_sample() {
    let mut state = tev_state(None);
    state[448..452].copy_from_slice(&1u32.to_le_bytes());
    let mut indirect = IndirectTevState {
        encoding: INDIRECT_TEV_STATE_ENCODING_BP_WORDS_XF_V2,
        gen_mode: 1 << 16,
        matrices: [0; 9],
        imask: 0,
        commands: [0; 16],
        tex_scales: [0; 2],
        iref: 0,
        xf_num_tex_gens: 0,
    };

    indirect.commands[0] = 1 << 11;
    assert_eq!(
        required_texture_maps(&state, Some(&indirect)).unwrap(),
        [false; MAX_TEXTURES]
    );

    indirect.commands[0] = 1 << 9;
    assert_eq!(
        required_texture_maps(&state, Some(&indirect)).unwrap(),
        [true, false, false, false, false, false, false, false]
    );
}

#[test]
fn guest_derived_noncanonical_values_fail_closed_without_panicking() {
    let vertices = vec![0; 3 * VERTEX_BYTES as usize];
    let tev = tev_state(None);
    let required_tev = tev_state(Some(0));
    let mut draw = empty_draw(&vertices, &tev);
    draw.vertices = &vertices[..vertices.len() - 1];
    assert!(matches!(
        encode(&PacketInput {
            version: PacketVersion::V4,
            terminal: xfb_terminal(),
            draws: &[draw],
            textures: &[],
        }),
        Err(PacketError::NonCanonical("vertex record byte length"))
    ));

    let mut draw = empty_draw(&vertices, &required_tev);
    draw.textures[0] = TextureBinding {
        texture: Some(u32::MAX),
        mode0: 0,
        mode1: 0,
    };
    assert!(matches!(
        encode(&PacketInput {
            version: PacketVersion::V4,
            terminal: xfb_terminal(),
            draws: &[draw],
            textures: &[],
        }),
        Err(PacketError::InvalidField("texture reference"))
    ));

    let missing = empty_draw(&vertices, &required_tev);
    assert!(matches!(
        encode(&PacketInput {
            version: PacketVersion::V4,
            terminal: xfb_terminal(),
            draws: &[missing],
            textures: &[],
        }),
        Err(PacketError::NonCanonical(
            "TEV texture binding does not match live dataflow"
        ))
    ));

    let pixels = [0; 4];
    let textures = [TextureInput {
        key: "unused",
        pixels: Some(&pixels),
        address: 0,
        generation: 0,
        width: 1,
        height: 1,
        mip_level_count: 1,
    }];
    let mut unused = empty_draw(&vertices, &tev);
    unused.textures[0].texture = Some(0);
    assert!(matches!(
        encode(&PacketInput {
            version: PacketVersion::V4,
            terminal: xfb_terminal(),
            draws: &[unused],
            textures: &textures,
        }),
        Err(PacketError::NonCanonical(
            "TEV texture binding does not match live dataflow"
        ))
    ));

    let malformed = [0xff; 159];
    assert_eq!(validate_envelope(&malformed), Err(PacketError::TooShort));
    let mut packet = encode_case("empty_terminal");
    packet[0x08..0x0c].copy_from_slice(&u32::MAX.to_le_bytes());
    assert_eq!(validate_envelope(&packet), Err(PacketError::LengthMismatch));
}

#[test]
fn checked_layout_rejects_all_u32_overflow_edges() {
    assert!(matches!(
        BaseLayout::new(u32::MAX, 0, 0, 0, 0),
        Err(PacketError::Overflow("draw table bytes"))
    ));
    assert!(matches!(
        BaseLayout::new(0, 0, 0, u32::MAX, 0),
        Err(PacketError::Overflow("key end"))
    ));
    assert!(matches!(
        TailLayout::new(PacketVersion::V7, u32::MAX - 7, 8, 0, 0, false),
        Err(PacketError::Overflow("evidence end"))
    ));
}

#[test]
fn arbitrary_truncation_and_single_byte_corruption_never_panic() {
    let packet = encode_case("mip_v7");
    for end in 0..packet.len() {
        let result = std::panic::catch_unwind(|| validate_envelope(&packet[..end]));
        assert!(result.is_ok(), "validator panicked at truncation {end}");
        assert!(result.unwrap().is_err(), "truncation {end} was accepted");
    }
    for offset in 0..packet.len() {
        let mut malformed = packet.clone();
        malformed[offset] ^= 0xff;
        let result = std::panic::catch_unwind(|| validate_envelope(&malformed));
        assert!(result.is_ok(), "validator panicked at byte {offset:#x}");
    }
}
