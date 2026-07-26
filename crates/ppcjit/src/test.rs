use std::alloc::Layout;

use cranelift_codegen::isa;
use gekko::disasm::{Extensions, Ins, Opcode};
use gekko::{Address, CondReg, Cpu, Exception, FloatControlReg, FloatPair, ProgramExceptionCause};

use crate::block::{BlockFn, Executed, ExitReason, Meta};
use crate::hooks::{Context, ExitData, Hooks};
use crate::{Artifact, CodegenSettings, FASTMEM_LUT_COUNT, FastmemLut, Jit, Sequence, Settings};

macro_rules! ppc {
    ($($mnemonic:ident $($arg:expr)*);* $(;)?) => {
        {
            let mut sequence = vec![];

            #[allow(unused_variables, unused_mut, unused_assignments, unused_imports, dead_code)]
            {
                use powerpc_asm::Argument;

                fn u(value: u32) -> Argument {
                    Argument::Unsigned(value)
                }

                fn i(value: i32) -> Argument {
                    Argument::Signed(value)
                }

                fn gpr(index: u32) -> Argument {
                    u(index)
                }

                fn fpr(index: u32) -> Argument {
                    u(index)
                }

                fn off(value: i32) -> Argument {
                    i(value)
                }

                $(
                    let mut i = 0;
                    let mut arguments = [Argument::None; 5];

                    $(
                        arguments[i] = $arg;
                        i += 1;
                    )*

                    let ins = gekko::disasm::Ins::new(
                        powerpc_asm::assemble(stringify!($mnemonic), &arguments).unwrap(),
                        gekko::disasm::Extensions::gekko_broadway(),
                    );

                    sequence.push(ins);
                )*
            }

            Sequence(sequence)
        }
    };
}

fn compile_sequence(isa: isa::Builder, sequence: Sequence) -> (Artifact, Meta) {
    let mut jit = Jit::with_isa(
        isa,
        Settings {
            codegen: CodegenSettings {
                nop_syscalls: false,
                force_fpu: false,
                ignore_unimplemented: false,
                round_to_single: false,
            },
            cache_path: None,
            exit_data_layout: Layout::new::<u8>(),
        },
        unsafe { Hooks::stub() },
    );

    jit.build_artifact(sequence.0.into_iter()).unwrap()
}

fn test_sequence(name: &str, sequence: Sequence) {
    fn inner(name: &str, sequence: Sequence, isa: isa::Builder, isa_name: &str) {
        let (artifact, meta) = compile_sequence(isa, sequence.clone());
        let clir = meta.clir.unwrap();
        let disasm = artifact.disasm.unwrap();
        insta::assert_snapshot!(format!("{isa_name}_{}_clir", name), clir);
        insta::assert_snapshot!(format!("{isa_name}_{}_disasm", name), disasm);
    }

    inner(
        name,
        sequence.clone(),
        jitclif::isa::x86_64_v1(),
        "x86_64_v1",
    );
    inner(
        name,
        sequence.clone(),
        jitclif::isa::x86_64_v3(),
        "x86_64_v3",
    );
    inner(name, sequence.clone(), jitclif::isa::aarch64(), "aarch64");
}

#[test]
fn fcmpu() {
    test_sequence(
        "fcmpu",
        ppc! {
            fcmpu u(0) fpr(1) fpr(2)
        },
    );
}

#[test]
fn ps_add_acc() {
    test_sequence(
        "ps_add_acc",
        ppc! {
            ps_add fpr(0) fpr(0) fpr(1);
            ps_add fpr(0) fpr(0) fpr(2);
            ps_add fpr(0) fpr(0) fpr(3);
            ps_add fpr(0) fpr(0) fpr(4);
        },
    );
}

#[test]
fn gu_vec_scale() {
    // ps_guVecScale:
    // 	psq_l		fr2,0(r3),0,0
    // 	psq_l		fr3,8(r3),1,0
    // 	ps_muls0	fr4,fr2,fr1
    // 	psq_st		fr4,0(r4),0,0
    // 	ps_muls0	fr4,fr3,fr1
    // 	psq_st		fr4,8(r4),1,0

    test_sequence(
        "gu_vec_scale",
        ppc! {
            psq_l fpr(2) off(0) gpr(3) u(0) u(0);
            psq_l fpr(3) off(8) gpr(3) u(1) u(0);
            ps_muls0 fpr(4) fpr(2) fpr(1);
            psq_st fpr(4) off(0) gpr(4) u(0) u(0);
            ps_muls0 fpr(4) fpr(3) fpr(1);
            psq_st fpr(4) off(8) gpr(4) u(0) u(0);
        },
    );
}

#[test]
fn gu_vec_add() {
    // #define V1_XY	fr2
    // #define V1_Z		fr3
    // #define V2_XY	fr4
    // #define V2_Z		fr5
    // #define D1_XY	fr6
    // #define D1_Z		fr7
    // #define D2_XY	fr8
    // #define D2_Z		fr9
    //
    // ps_guVecAdd:
    // 	psq_l		V1_XY,0(r3),0,0
    // 	psq_l		V2_XY,0(r4),0,0
    // 	ps_add		D1_XY,V1_XY,V2_XY
    // 	psq_st		D1_XY,0(r5),0,0
    // 	psq_l		V1_Z,8(r3),1,0
    // 	psq_l		V2_Z,8(r4),1,0
    // 	ps_add		D1_Z,V1_Z,V2_Z
    // 	psq_st		D1_Z,8(r5),1,0

    test_sequence(
        "gu_vec_add",
        ppc! {
            psq_l fpr(2) off(0) gpr(3) u(0) u(0);
            psq_l fpr(4) off(0) gpr(4) u(0) u(0);
            ps_add fpr(6) fpr(2) fpr(4);
            psq_st fpr(6) off(0) gpr(5) u(0) u(0);
            psq_l fpr(3) off(8) gpr(3) u(1) u(0);
            psq_l fpr(5) off(8) gpr(4) u(1) u(0);
            ps_add fpr(7) fpr(3) fpr(5);
            psq_st fpr(7) off(8) gpr(5) u(1) u(0);
        },
    );
}

#[test]
fn gu_mtx_identity() {
    // ps_guMtxIdentity:
    // 	lfs		fr0,Unit01@sdarel(r13)
    // 	lfs		fr1,Unit01+4@sdarel(r13)
    // 	psq_st		fr0,8(r3),0,0
    // 	ps_merge01	fr2,fr0,fr1
    // 	psq_st		fr0,24(r3),0,0
    // 	ps_merge10	fr3,fr1,fr0
    // 	psq_st		fr0,32(r3),0,0
    // 	psq_st		fr2,16(r3),0,0
    // 	psq_st		fr3,0(r3),0,0
    // 	psq_st		fr3,40(r3),0,0

    test_sequence(
        "gu_mtx_identity",
        ppc! {
            lfs fpr(0) off(0) gpr(31);
            lfs fpr(1) off(4) gpr(31);
            psq_st fpr(0) off(8) gpr(3) u(0) u(0);
            ps_merge01 fpr(2) fpr(0) fpr(1);
            psq_st fpr(0) off(24) gpr(3) u(0) u(0);
            ps_merge10 fpr(3) fpr(1) fpr(0);
            psq_st fpr(0) off(32) gpr(3) u(0) u(0);
            psq_st fpr(2) off(16) gpr(3) u(0) u(0);
            psq_st fpr(3) off(0) gpr(3) u(0) u(0);
            psq_st fpr(3) off(40) gpr(3) u(0) u(0);
        },
    );
}

struct NativeProgramExceptionContext {
    cpu: Cpu,
    fastmem: Box<FastmemLut>,
    exit_srr1: u32,
    exit_executed: Executed,
}

extern "C-unwind" fn native_program_exception_registers(ctx: *mut Context) -> *mut Cpu {
    let ctx = unsafe { &mut *ctx.cast::<NativeProgramExceptionContext>() };
    &raw mut ctx.cpu
}

extern "C-unwind" fn native_program_exception_fastmem(ctx: *mut Context) -> *mut FastmemLut {
    let ctx = unsafe { &mut *ctx.cast::<NativeProgramExceptionContext>() };
    &raw mut *ctx.fastmem
}

extern "C-unwind" fn native_program_exception_exit(
    ctx: *const Context,
    _: *mut ExitData,
    _: ExitReason,
    executed: Executed,
) -> Option<BlockFn> {
    let ctx = unsafe { &mut *ctx.cast_mut().cast::<NativeProgramExceptionContext>() };
    ctx.exit_srr1 = ctx.cpu.supervisor.exception.srr[1];
    ctx.exit_executed = executed;
    None
}

#[test]
fn native_illegal_instruction_records_the_program_cause_before_exit() {
    let illegal = Ins::new(0, Extensions::gekko_broadway());
    assert_eq!(illegal.op, Opcode::Illegal);

    let mut hooks = unsafe { Hooks::stub() };
    hooks.get_registers = native_program_exception_registers;
    hooks.get_fastmem = native_program_exception_fastmem;
    hooks.exit = native_program_exception_exit;

    let mut jit = Jit::new(
        Settings {
            codegen: CodegenSettings::default(),
            cache_path: None,
            exit_data_layout: Layout::new::<u8>(),
        },
        hooks,
    );
    let block = jit.build([illegal].into_iter()).unwrap();
    let mut context = NativeProgramExceptionContext {
        cpu: Cpu {
            pc: Address(0x8000_1234),
            ..Cpu::default()
        },
        fastmem: Box::new([None; FASTMEM_LUT_COUNT]),
        exit_srr1: 0,
        exit_executed: Executed::default(),
    };
    context.cpu.supervisor.exception.srr[1] = Exception::SPECIAL_SRR1_BITS_MASK;

    unsafe {
        jit.call((&raw mut context).cast::<Context>(), block.as_ptr());
    }

    assert_eq!(context.cpu.pc, Address(0xfff0_0700));
    assert_eq!(context.cpu.supervisor.exception.srr[0], 0x8000_1234);
    assert_eq!(
        context.exit_srr1 & Exception::SPECIAL_SRR1_BITS_MASK,
        ProgramExceptionCause::IllegalInstruction.srr1_bits()
    );
    assert_eq!(context.exit_srr1, context.cpu.supervisor.exception.srr[1]);
}

#[test]
fn native_trap_word_preserves_the_taken_instruction_boundary() {
    let twi_sequence = ppc! {
        addi gpr(6) gpr(6) i(0);
        twi u(0x02) gpr(3) i(-1);
        addi gpr(5) gpr(0) i(0x55aa);
    };
    assert_eq!(twi_sequence.0[1].op, Opcode::Twi);
    let tw_sequence = ppc! {
        addi gpr(6) gpr(6) i(0);
        tw u(0x14) gpr(3) gpr(4);
        addi gpr(5) gpr(0) i(0x55aa);
    };
    assert_eq!(tw_sequence.0[1].op, Opcode::Tw);

    let mut hooks = unsafe { Hooks::stub() };
    hooks.get_registers = native_program_exception_registers;
    hooks.get_fastmem = native_program_exception_fastmem;
    hooks.exit = native_program_exception_exit;
    let mut jit = Jit::new(
        Settings {
            codegen: CodegenSettings::default(),
            cache_path: None,
            exit_data_layout: Layout::new::<u8>(),
        },
        hooks,
    );
    let twi_block = jit.build(twi_sequence.0.into_iter()).unwrap();
    let tw_block = jit.build(tw_sequence.0.into_iter()).unwrap();
    let initial_pc = 0x8000_2000;
    let untouched_r5 = 0xdead_beef;
    let mut context = NativeProgramExceptionContext {
        cpu: Cpu::default(),
        fastmem: Box::new([None; FASTMEM_LUT_COUNT]),
        exit_srr1: 0,
        exit_executed: Executed::default(),
    };

    context.cpu.pc = Address(initial_pc);
    context.cpu.user.gpr[3] = 0xffff_fffe;
    context.cpu.user.gpr[5] = untouched_r5;
    unsafe {
        jit.call((&raw mut context).cast::<Context>(), twi_block.as_ptr());
    }
    assert_eq!(context.cpu.pc, Address(0xfff0_0700));
    assert_eq!(context.cpu.supervisor.exception.srr[0], initial_pc + 4);
    assert_eq!(context.cpu.user.gpr[5], untouched_r5);
    assert_eq!(
        context.exit_srr1 & ProgramExceptionCause::SRR1_MASK,
        ProgramExceptionCause::Trap.srr1_bits()
    );
    assert_eq!(context.exit_executed.instructions, 2);
    assert_eq!(context.exit_executed.cycles, 4);

    context.cpu = Cpu {
        pc: Address(initial_pc),
        ..Cpu::default()
    };
    context.cpu.user.gpr[3] = 0xffff_ffff;
    context.cpu.user.gpr[5] = untouched_r5;
    context.exit_srr1 = 0;
    context.exit_executed = Executed::default();
    unsafe {
        jit.call((&raw mut context).cast::<Context>(), twi_block.as_ptr());
    }
    assert_eq!(context.cpu.pc, Address(initial_pc + 12));
    assert_eq!(context.cpu.supervisor.exception.srr[0], 0);
    assert_eq!(context.cpu.user.gpr[5], 0x55aa);
    assert_eq!(context.exit_srr1 & ProgramExceptionCause::SRR1_MASK, 0);
    assert_eq!(context.exit_executed.instructions, 3);
    assert_eq!(context.exit_executed.cycles, 6);

    context.cpu = Cpu {
        pc: Address(initial_pc),
        ..Cpu::default()
    };
    context.cpu.user.gpr[3] = 0x8000_0000;
    context.cpu.user.gpr[4] = 0x8000_0000;
    context.cpu.user.gpr[5] = untouched_r5;
    context.exit_srr1 = 0;
    context.exit_executed = Executed::default();
    unsafe {
        jit.call((&raw mut context).cast::<Context>(), tw_block.as_ptr());
    }
    assert_eq!(context.cpu.pc, Address(0xfff0_0700));
    assert_eq!(context.cpu.supervisor.exception.srr[0], initial_pc + 4);
    assert_eq!(context.cpu.user.gpr[5], untouched_r5);
    assert_eq!(
        context.exit_srr1 & ProgramExceptionCause::SRR1_MASK,
        ProgramExceptionCause::Trap.srr1_bits()
    );
    assert_eq!(context.exit_executed.instructions, 2);
    assert_eq!(context.exit_executed.cycles, 4);
}

fn ps_abs(fd: u8, fb: u8, record: bool) -> Ins {
    Ins::new(
        0x1000_0210 | u32::from(fd) << 21 | u32::from(fb) << 11 | u32::from(record),
        Extensions::gekko_broadway(),
    )
}

fn ps_nabs(fd: u8, fb: u8, record: bool) -> Ins {
    Ins::new(
        0x1000_0110 | u32::from(fd) << 21 | u32::from(fb) << 11 | u32::from(record),
        Extensions::gekko_broadway(),
    )
}

fn mtfsfi(field: u8, immediate: u8, record: bool) -> Ins {
    Ins::new(
        0xfc00_010c
            | u32::from(field & 7) << 23
            | u32::from(immediate & 0xf) << 12
            | u32::from(record),
        Extensions::gekko_broadway(),
    )
}

#[test]
fn native_paired_sign_moves_and_mtfsfi_preserve_exact_state() {
    let moves = [ps_abs(3, 1, false), ps_nabs(4, 2, true)];
    assert_eq!(moves[0].op, Opcode::PsAbs);
    assert_eq!(moves[1].op, Opcode::PsNabs);
    let controls = [mtfsfi(3, 8, false), mtfsfi(7, 5, true)];
    assert_eq!(controls[0].op, Opcode::Mtfsfi);
    assert_eq!(controls[1].op, Opcode::Mtfsfi);
    let disabled = [mtfsfi(3, 8, true)];

    let mut hooks = unsafe { Hooks::stub() };
    hooks.get_registers = native_program_exception_registers;
    hooks.get_fastmem = native_program_exception_fastmem;
    hooks.exit = native_program_exception_exit;
    let mut jit = Jit::new(
        Settings {
            codegen: CodegenSettings::default(),
            cache_path: None,
            exit_data_layout: Layout::new::<u8>(),
        },
        hooks,
    );
    let moves = jit.build(moves.into_iter()).unwrap();
    let controls = jit.build(controls.into_iter()).unwrap();
    let disabled = jit.build(disabled.into_iter()).unwrap();
    let initial_pc = 0x8000_4000;
    let initial_cr = 0xa5ff_ffff;
    let mut context = NativeProgramExceptionContext {
        cpu: Cpu::default(),
        fastmem: Box::new([None; FASTMEM_LUT_COUNT]),
        exit_srr1: 0,
        exit_executed: Executed::default(),
    };

    context.cpu.pc = Address(initial_pc);
    context.cpu.supervisor.config.msr = context
        .cpu
        .supervisor
        .config
        .msr
        .clone()
        .with_float_available(true);
    context.cpu.user.fpr[1] = FloatPair([
        f64::from_bits(0x8000_0000_0000_0000),
        f64::from_bits(0xfff8_1234_5678_9abc),
    ]);
    context.cpu.user.fpr[2] = FloatPair([
        f64::from_bits(0x7ff0_0000_0000_0000),
        f64::from_bits(0x7ff8_dead_beef_0042),
    ]);
    context.cpu.user.fpscr = FloatControlReg::from_bits(0x9000_0000);
    context.cpu.user.cr = CondReg::from_bits(initial_cr);
    unsafe {
        jit.call((&raw mut context).cast::<Context>(), moves.as_ptr());
    }
    assert_eq!(
        context.cpu.user.fpr[3].map(f64::to_bits),
        [0x0000_0000_0000_0000, 0x7ff8_1234_5678_9abc]
    );
    assert_eq!(
        context.cpu.user.fpr[4].map(f64::to_bits),
        [0xfff0_0000_0000_0000, 0xfff8_dead_beef_0042]
    );
    assert_eq!(context.cpu.user.fpscr.to_bits(), 0x9000_0000);
    assert_eq!(context.cpu.user.cr.to_bits(), 0xa9ff_ffff);
    assert_eq!(context.cpu.pc, Address(initial_pc + 8));
    assert_eq!(context.exit_executed.instructions, 2);
    assert_eq!(context.exit_executed.cycles, 4);

    context.cpu = Cpu {
        pc: Address(initial_pc),
        ..Cpu::default()
    };
    context.cpu.supervisor.config.msr = context
        .cpu
        .supervisor
        .config
        .msr
        .clone()
        .with_float_available(true);
    context.cpu.user.fpscr = FloatControlReg::from_bits(0x8000_0080);
    context.cpu.user.cr = CondReg::from_bits(initial_cr);
    context.exit_executed = Executed::default();
    unsafe {
        jit.call((&raw mut context).cast::<Context>(), controls.as_ptr());
    }
    assert_eq!(context.cpu.user.fpscr.to_bits(), 0xe008_0085);
    assert_eq!(context.cpu.user.cr.to_bits(), 0xaeff_ffff);
    assert_eq!(context.cpu.pc, Address(initial_pc + 8));
    assert_eq!(context.exit_executed.instructions, 2);
    assert_eq!(context.exit_executed.cycles, 2);

    context.cpu = Cpu {
        pc: Address(initial_pc),
        ..Cpu::default()
    };
    context.cpu.user.fpscr = FloatControlReg::from_bits(0x1234_5678);
    context.cpu.user.cr = CondReg::from_bits(initial_cr);
    context.exit_executed = Executed::default();
    unsafe {
        jit.call((&raw mut context).cast::<Context>(), disabled.as_ptr());
    }
    assert_eq!(context.cpu.pc, Address(0xfff0_0800));
    assert_eq!(context.cpu.supervisor.exception.srr[0], initial_pc);
    assert_eq!(context.cpu.user.fpscr.to_bits(), 0x1234_5678);
    assert_eq!(context.cpu.user.cr.to_bits(), initial_cr);
    assert_eq!(context.exit_executed.instructions, 1);
    assert_eq!(context.exit_executed.cycles, 2);
}
