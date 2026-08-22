use std::alloc::Layout;
use std::ptr::NonNull;

use cranelift_codegen::isa;
use gekko::disasm::{Extensions, Ins, Opcode};
use gekko::{
    Address, CondReg, Cpu, Exception, FloatControlReg, FloatPair, ProgramExceptionCause, XerReg,
};

use crate::block::{BlockFn, Executed, ExitReason, Meta};
use crate::hooks::{Context, ExitData, Hooks, READ_COMPLETE, READ_FAULT, READ_YIELD};
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

fn lswx(rd: u8, ra: u8, rb: u8) -> Ins {
    Ins::new(
        0x7c00_042a | u32::from(rd) << 21 | u32::from(ra) << 16 | u32::from(rb) << 11,
        Extensions::gekko_broadway(),
    )
}

fn dcbz_l(ra: u8, rb: u8) -> Ins {
    Ins::new(
        0x1000_07ec | u32::from(ra) << 16 | u32::from(rb) << 11,
        Extensions::gekko_broadway(),
    )
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

struct NativeLswxContext {
    cpu: Cpu,
    fastmem: Box<FastmemLut>,
    bytes: [u8; 128],
    reads: Vec<u32>,
    fail_at: Option<usize>,
    exit_executed: Executed,
}

struct NativeSlowReadContext {
    cpu: Cpu,
    fastmem: Box<FastmemLut>,
    statuses: Vec<u8>,
    attempts: Vec<u32>,
    value: i32,
    next_link: Option<BlockFn>,
    exits: Vec<(ExitReason, Executed)>,
}

impl NativeSlowReadContext {
    fn new(statuses: impl IntoIterator<Item = u8>) -> Self {
        Self {
            cpu: Cpu::default(),
            fastmem: Box::new([None; FASTMEM_LUT_COUNT]),
            statuses: statuses.into_iter().collect(),
            attempts: Vec::new(),
            value: 0x89ab_cdefu32 as i32,
            next_link: None,
            exits: Vec::new(),
        }
    }
}

const LOCKED_CACHE_BASE: u32 = 0xe000_0000;
const LOCKED_CACHE_PAGE_SIZE: usize = 1 << 17;
const HID2_LCE: u32 = 0x1000_0000;

struct NativeDcbzLContext {
    cpu: Cpu,
    fastmem: Box<FastmemLut>,
    locked_cache_page: Box<[u8]>,
    write_attempts: Vec<(u32, i32)>,
    fail_at: Option<usize>,
    exit_reason: Option<ExitReason>,
    exit_executed: Executed,
}

impl NativeDcbzLContext {
    fn new() -> Self {
        Self {
            cpu: Cpu::default(),
            fastmem: Box::new([None; FASTMEM_LUT_COUNT]),
            locked_cache_page: vec![0xa5; LOCKED_CACHE_PAGE_SIZE].into_boxed_slice(),
            write_attempts: Vec::new(),
            fail_at: None,
            exit_reason: None,
            exit_executed: Executed::default(),
        }
    }

    fn map_locked_cache_fastmem(&mut self) {
        let page = usize::try_from(LOCKED_CACHE_BASE >> 17).unwrap();
        self.fastmem[page] = NonNull::new(self.locked_cache_page.as_mut_ptr());
    }
}

extern "C-unwind" fn native_lswx_registers(ctx: *mut Context) -> *mut Cpu {
    let ctx = unsafe { &mut *ctx.cast::<NativeLswxContext>() };
    &raw mut ctx.cpu
}

extern "C-unwind" fn native_slow_read_registers(ctx: *mut Context) -> *mut Cpu {
    let ctx = unsafe { &mut *ctx.cast::<NativeSlowReadContext>() };
    &raw mut ctx.cpu
}

extern "C-unwind" fn native_slow_read_fastmem(ctx: *mut Context) -> *mut FastmemLut {
    let ctx = unsafe { &mut *ctx.cast::<NativeSlowReadContext>() };
    &raw mut *ctx.fastmem
}

extern "C-unwind" fn native_slow_read_i32(
    ctx: *mut Context,
    address: Address,
    output: *mut i32,
) -> u8 {
    let ctx = unsafe { &mut *ctx.cast::<NativeSlowReadContext>() };
    let attempt = ctx.attempts.len();
    ctx.attempts.push(address.value());
    // Deliberately populate the scratch slot for every status. A yield or fault must not expose it
    // through the guest destination register.
    unsafe { output.write(ctx.value) };
    let status = ctx.statuses.get(attempt).copied().unwrap_or(READ_COMPLETE);
    if status != READ_COMPLETE && status != READ_YIELD {
        ctx.cpu.supervisor.exception.dsisr = 0x4200_0000;
    }
    status
}

extern "C-unwind" fn native_slow_read_exit(
    ctx: *const Context,
    _: *mut ExitData,
    reason: ExitReason,
    executed: Executed,
) -> Option<BlockFn> {
    let ctx = unsafe { &mut *ctx.cast_mut().cast::<NativeSlowReadContext>() };
    ctx.exits.push((reason, executed));
    if reason == ExitReason::YIELD {
        None
    } else {
        ctx.next_link.take()
    }
}

extern "C-unwind" fn native_lswx_fastmem(ctx: *mut Context) -> *mut FastmemLut {
    let ctx = unsafe { &mut *ctx.cast::<NativeLswxContext>() };
    &raw mut *ctx.fastmem
}

extern "C-unwind" fn native_lswx_read_i8(
    ctx: *mut Context,
    address: Address,
    output: *mut i8,
) -> u8 {
    let ctx = unsafe { &mut *ctx.cast::<NativeLswxContext>() };
    let index = ctx.reads.len();
    ctx.reads.push(address.value());
    if ctx.fail_at == Some(index) {
        ctx.cpu.supervisor.exception.dsisr = 0x4200_0000;
        return READ_FAULT;
    }
    unsafe {
        output.write(ctx.bytes[index].cast_signed());
    }
    READ_COMPLETE
}

extern "C-unwind" fn native_lswx_exit(
    ctx: *const Context,
    _: *mut ExitData,
    _: ExitReason,
    executed: Executed,
) -> Option<BlockFn> {
    let ctx = unsafe { &mut *ctx.cast_mut().cast::<NativeLswxContext>() };
    ctx.exit_executed = executed;
    None
}

extern "C-unwind" fn native_dcbz_l_registers(ctx: *mut Context) -> *mut Cpu {
    let ctx = unsafe { &mut *ctx.cast::<NativeDcbzLContext>() };
    &raw mut ctx.cpu
}

extern "C-unwind" fn native_dcbz_l_fastmem(ctx: *mut Context) -> *mut FastmemLut {
    let ctx = unsafe { &mut *ctx.cast::<NativeDcbzLContext>() };
    &raw mut *ctx.fastmem
}

extern "C-unwind" fn native_dcbz_l_write_i32(
    ctx: *mut Context,
    address: Address,
    value: i32,
) -> bool {
    let ctx = unsafe { &mut *ctx.cast::<NativeDcbzLContext>() };
    let attempt = ctx.write_attempts.len();
    ctx.write_attempts.push((address.value(), value));
    if ctx.fail_at == Some(attempt) {
        ctx.cpu.supervisor.exception.dsisr = 0x4200_0000;
        return false;
    }

    let Some(offset) = address
        .value()
        .checked_sub(LOCKED_CACHE_BASE)
        .and_then(|offset| usize::try_from(offset).ok())
    else {
        return false;
    };
    let Some(destination) = ctx.locked_cache_page.get_mut(offset..offset + 4) else {
        return false;
    };
    destination.copy_from_slice(&value.to_be_bytes());
    true
}

extern "C-unwind" fn native_dcbz_l_exit(
    ctx: *const Context,
    _: *mut ExitData,
    reason: ExitReason,
    executed: Executed,
) -> Option<BlockFn> {
    let ctx = unsafe { &mut *ctx.cast_mut().cast::<NativeDcbzLContext>() };
    ctx.exit_reason = Some(reason);
    ctx.exit_executed = executed;
    None
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
fn native_slow_load_yields_at_the_exact_retry_boundary() {
    let sequence = ppc! {
        lwz gpr(3) off(0) gpr(5);
        addi gpr(6) gpr(6) i(1);
    };
    let mut hooks = unsafe { Hooks::stub() };
    hooks.get_registers = native_slow_read_registers;
    hooks.get_fastmem = native_slow_read_fastmem;
    hooks.read_i32 = native_slow_read_i32;
    hooks.exit = native_slow_read_exit;
    let mut jit = Jit::new(
        Settings {
            codegen: CodegenSettings::default(),
            cache_path: None,
            exit_data_layout: Layout::new::<u8>(),
        },
        hooks,
    );
    let block = jit.build(sequence.0.into_iter()).unwrap();

    let initial_pc = 0x8000_7000;
    let address = 0x084f_0500;
    let untouched_destination = 0x55aa_33cc;
    let untouched_dar = 0x1111_2222;
    let untouched_dsisr = 0x3333_4444;
    let mut context = NativeSlowReadContext::new([READ_YIELD, READ_COMPLETE]);
    context.cpu.pc = Address(initial_pc);
    context.cpu.user.gpr[3] = untouched_destination;
    context.cpu.user.gpr[5] = address;
    context.cpu.user.gpr[6] = 9;
    context.cpu.supervisor.exception.dar = untouched_dar;
    context.cpu.supervisor.exception.dsisr = untouched_dsisr;
    // A normal synchronous exit would follow this link immediately. A cooperative yield must
    // return to the dispatcher even when the unchanged PC already has a compiled native block.
    context.next_link = Some(block.as_ptr());

    unsafe {
        jit.call((&raw mut context).cast::<Context>(), block.as_ptr());
    }

    assert_eq!(context.attempts, [address]);
    assert_eq!(context.cpu.pc, Address(initial_pc));
    assert_eq!(context.cpu.user.gpr[3], untouched_destination);
    assert_eq!(context.cpu.user.gpr[5], address);
    assert_eq!(context.cpu.user.gpr[6], 9);
    assert_eq!(context.cpu.supervisor.exception.dar, untouched_dar);
    assert_eq!(context.cpu.supervisor.exception.dsisr, untouched_dsisr);
    assert_eq!(context.exits.len(), 1);
    assert_eq!(context.exits[0].0, ExitReason::YIELD);
    assert_eq!(context.exits[0].1.instructions, 0);
    assert_eq!(context.exits[0].1.cycles, 0);
    assert_eq!(context.next_link, Some(block.as_ptr()));

    // Redispatching the unchanged PC retries the load. Only the successful attempt exposes the
    // scratch value and advances through the following instruction.
    context.next_link = None;
    unsafe {
        jit.call((&raw mut context).cast::<Context>(), block.as_ptr());
    }
    assert_eq!(context.attempts, [address, address]);
    assert_eq!(context.cpu.pc, Address(initial_pc + 8));
    assert_eq!(context.cpu.user.gpr[3], context.value as u32);
    assert_eq!(context.cpu.user.gpr[5], address);
    assert_eq!(context.cpu.user.gpr[6], 10);
    assert_eq!(context.cpu.supervisor.exception.dar, untouched_dar);
    assert_eq!(context.cpu.supervisor.exception.dsisr, untouched_dsisr);
    assert_eq!(context.exits.len(), 2);
    assert_eq!(context.exits[1].1.instructions, 2);
    assert_eq!(context.exits[1].1.cycles, 4);

    // Every status outside {complete, yield} follows the established read-fault path rather than
    // consuming the output slot as a successful load.
    for status in [READ_FAULT, 3, u8::MAX] {
        let mut fault = NativeSlowReadContext::new([status]);
        fault.cpu.pc = Address(initial_pc);
        fault.cpu.user.gpr[3] = untouched_destination;
        fault.cpu.user.gpr[5] = address;
        fault.cpu.user.gpr[6] = 9;
        unsafe {
            jit.call((&raw mut fault).cast::<Context>(), block.as_ptr());
        }
        assert_eq!(fault.attempts, [address], "status {status}");
        assert_eq!(
            fault.cpu.user.gpr[3], untouched_destination,
            "status {status}"
        );
        assert_eq!(fault.cpu.user.gpr[6], 9, "status {status}");
        assert_eq!(
            fault.cpu.supervisor.exception.dar, address,
            "status {status}"
        );
        assert_eq!(
            fault.cpu.supervisor.exception.dsisr, 0x4200_0000,
            "status {status}"
        );
        assert_eq!(
            fault.cpu.supervisor.exception.srr[0], initial_pc,
            "status {status}"
        );
        assert_eq!(fault.cpu.pc, Address(0xfff0_0300), "status {status}");
        assert_eq!(fault.exits.len(), 1, "status {status}");
        assert_eq!(fault.exits[0].1.instructions, 1, "status {status}");
        assert_eq!(fault.exits[0].1.cycles, 2, "status {status}");
    }
}

#[test]
fn native_linked_region_preserves_a_slow_load_retry_boundary() {
    let prefix = ppc! {
        addi gpr(4) gpr(4) i(1);
    };
    let linked = ppc! {
        addi gpr(7) gpr(7) i(1);
        lwz gpr(3) off(0) gpr(5);
        addi gpr(6) gpr(6) i(1);
    };
    let resume = ppc! {
        lwz gpr(3) off(0) gpr(5);
        addi gpr(6) gpr(6) i(1);
    };
    let mut hooks = unsafe { Hooks::stub() };
    hooks.get_registers = native_slow_read_registers;
    hooks.get_fastmem = native_slow_read_fastmem;
    hooks.read_i32 = native_slow_read_i32;
    hooks.exit = native_slow_read_exit;
    let mut jit = Jit::new(
        Settings {
            codegen: CodegenSettings::default(),
            cache_path: None,
            exit_data_layout: Layout::new::<u8>(),
        },
        hooks,
    );
    let prefix_block = jit.build(prefix.0.into_iter()).unwrap();
    let linked_block = jit.build(linked.0.into_iter()).unwrap();
    let resume_block = jit.build(resume.0.into_iter()).unwrap();

    let initial_pc = 0x8000_7800;
    let address = 0x084f_0500;
    let untouched_destination = 0xa55a_33cc;
    let mut context = NativeSlowReadContext::new([READ_YIELD, READ_COMPLETE]);
    context.cpu.pc = Address(initial_pc);
    context.cpu.user.gpr[3] = untouched_destination;
    context.cpu.user.gpr[4] = 7;
    context.cpu.user.gpr[5] = address;
    context.cpu.user.gpr[6] = 11;
    context.cpu.user.gpr[7] = 13;
    context.cpu.supervisor.exception.dar = 0x1111_2222;
    context.cpu.supervisor.exception.dsisr = 0x3333_4444;
    context.next_link = Some(linked_block.as_ptr());

    // The prefix tail-links into another region. Work on both sides of that link is flushed and
    // accounted once, while the yielded load contributes no counters and leaves PC on itself.
    unsafe {
        jit.call((&raw mut context).cast::<Context>(), prefix_block.as_ptr());
    }
    assert_eq!(context.attempts, [address]);
    assert_eq!(context.cpu.pc, Address(initial_pc + 8));
    assert_eq!(context.cpu.user.gpr[3], untouched_destination);
    assert_eq!(context.cpu.user.gpr[4], 8);
    assert_eq!(context.cpu.user.gpr[6], 11);
    assert_eq!(context.cpu.user.gpr[7], 14);
    assert_eq!(context.cpu.supervisor.exception.dar, 0x1111_2222);
    assert_eq!(context.cpu.supervisor.exception.dsisr, 0x3333_4444);
    assert_eq!(context.exits.len(), 2);
    assert_eq!(context.exits[0].1.instructions, 1);
    assert_eq!(context.exits[0].1.cycles, 2);
    assert_eq!(context.exits[1].1.instructions, 1);
    assert_eq!(context.exits[1].1.cycles, 2);

    unsafe {
        jit.call((&raw mut context).cast::<Context>(), resume_block.as_ptr());
    }
    assert_eq!(context.attempts, [address, address]);
    assert_eq!(context.cpu.pc, Address(initial_pc + 16));
    assert_eq!(context.cpu.user.gpr[3], context.value as u32);
    assert_eq!(context.cpu.user.gpr[4], 8);
    assert_eq!(context.cpu.user.gpr[6], 12);
    assert_eq!(context.cpu.user.gpr[7], 14);
    assert_eq!(context.exits.len(), 3);
    assert_eq!(context.exits[2].1.instructions, 2);
    assert_eq!(context.exits[2].1.cycles, 4);
}

#[test]
fn native_dcbz_l_covers_locked_cache_addressing_faults_and_continuation() {
    let zero_base = dcbz_l(0, 3);
    let corpus_indexed = dcbz_l(6, 3);
    assert_eq!(zero_base.code, 0x1000_1fec);
    assert_eq!(corpus_indexed.code, 0x1006_1fec);
    assert_eq!(zero_base.op, Opcode::DcbzL);
    assert_eq!(corpus_indexed.op, Opcode::DcbzL);

    // addi r5,r5,1 must remain in the translation and execute after an enabled dcbz_l.
    let trailing = Ins::new(0x38a5_0001, Extensions::gekko_broadway());
    let mut hooks = unsafe { Hooks::stub() };
    hooks.get_registers = native_dcbz_l_registers;
    hooks.get_fastmem = native_dcbz_l_fastmem;
    hooks.write_i32 = native_dcbz_l_write_i32;
    hooks.exit = native_dcbz_l_exit;
    let mut jit = Jit::new(
        Settings {
            codegen: CodegenSettings::default(),
            cache_path: None,
            exit_data_layout: Layout::new::<u8>(),
        },
        hooks,
    );
    let zero_base_block = jit.build([zero_base, trailing].into_iter()).unwrap();
    let indexed_block = jit.build([corpus_indexed, trailing].into_iter()).unwrap();
    assert_eq!(zero_base_block.meta().seq.0, [zero_base, trailing]);
    assert_eq!(zero_base_block.meta().cycles, 4);
    assert_eq!(indexed_block.meta().seq.0, [corpus_indexed, trailing]);
    assert_eq!(indexed_block.meta().cycles, 4);

    let initial_pc = 0x8000_6000;
    let line_offset = 0x20usize;
    let expected_slow_writes = (0..8)
        .map(|index| (LOCKED_CACHE_BASE + 0x20 + index * 4, 0))
        .collect::<Vec<_>>();
    let assert_guarded_zero_line = |cache: &[u8]| {
        assert!(cache[..line_offset].iter().all(|byte| *byte == 0xa5));
        assert!(
            cache[line_offset..line_offset + 32]
                .iter()
                .all(|byte| *byte == 0)
        );
        assert!(
            cache[line_offset + 32..line_offset + 64]
                .iter()
                .all(|byte| *byte == 0xa5)
        );
    };

    // RA=0 takes RB directly, aligns the effective address down, and reaches slow backing hooks.
    let mut slow = NativeDcbzLContext::new();
    slow.cpu.pc = Address(initial_pc);
    slow.cpu.supervisor.config.hid[2] = HID2_LCE;
    slow.cpu.user.gpr[3] = LOCKED_CACHE_BASE + 0x3d;
    slow.cpu.user.gpr[5] = 0x1234;
    unsafe {
        jit.call((&raw mut slow).cast::<Context>(), zero_base_block.as_ptr());
    }
    assert_eq!(slow.write_attempts, expected_slow_writes);
    assert_guarded_zero_line(&slow.locked_cache_page);
    assert_eq!(slow.cpu.user.gpr[5], 0x1235);
    assert_eq!(slow.cpu.pc, Address(initial_pc + 8));
    assert_eq!(slow.exit_reason, Some(ExitReason::SYNC));
    assert_eq!(slow.exit_executed.instructions, 2);
    assert_eq!(slow.exit_executed.cycles, 4);

    // The SDK's exact RA+RB encoding reaches the same aligned line through native fastmem.
    let mut fast = NativeDcbzLContext::new();
    fast.map_locked_cache_fastmem();
    fast.cpu.pc = Address(initial_pc);
    fast.cpu.supervisor.config.hid[2] = HID2_LCE;
    fast.cpu.user.gpr[6] = LOCKED_CACHE_BASE + 0x20;
    fast.cpu.user.gpr[3] = 0x1d;
    fast.cpu.user.gpr[5] = 9;
    unsafe {
        jit.call((&raw mut fast).cast::<Context>(), indexed_block.as_ptr());
    }
    assert!(fast.write_attempts.is_empty());
    assert_guarded_zero_line(&fast.locked_cache_page);
    assert_eq!(fast.cpu.user.gpr[5], 10);
    assert_eq!(fast.cpu.pc, Address(initial_pc + 8));
    assert_eq!(fast.exit_executed.instructions, 2);
    assert_eq!(fast.exit_executed.cycles, 4);

    // HID2[LCE]=0 is a Program/Illegal Instruction boundary: no memory access or trailing addi.
    let mut disabled = NativeDcbzLContext::new();
    disabled.cpu.pc = Address(initial_pc);
    disabled.cpu.user.gpr[6] = LOCKED_CACHE_BASE + 0x20;
    disabled.cpu.user.gpr[3] = 0x1d;
    disabled.cpu.user.gpr[5] = 0x55aa;
    unsafe {
        jit.call(
            (&raw mut disabled).cast::<Context>(),
            indexed_block.as_ptr(),
        );
    }
    assert!(disabled.write_attempts.is_empty());
    assert!(disabled.locked_cache_page.iter().all(|byte| *byte == 0xa5));
    assert_eq!(disabled.cpu.user.gpr[5], 0x55aa);
    assert_eq!(disabled.cpu.supervisor.exception.srr[0], initial_pc);
    assert_eq!(disabled.cpu.pc, Address(0xfff0_0700));
    assert_eq!(
        disabled.cpu.supervisor.exception.srr[1] & Exception::SPECIAL_SRR1_BITS_MASK,
        ProgramExceptionCause::IllegalInstruction.srr1_bits()
    );
    assert_eq!(disabled.exit_executed.instructions, 1);
    assert_eq!(disabled.exit_executed.cycles, 2);

    // A failed first slow write reports the aligned line address and exits at this instruction.
    let mut fault = NativeDcbzLContext::new();
    fault.cpu.pc = Address(initial_pc);
    fault.cpu.supervisor.config.hid[2] = HID2_LCE;
    fault.cpu.user.gpr[3] = LOCKED_CACHE_BASE + 0x3d;
    fault.cpu.user.gpr[5] = 0x55aa;
    fault.fail_at = Some(0);
    unsafe {
        jit.call((&raw mut fault).cast::<Context>(), zero_base_block.as_ptr());
    }
    assert_eq!(
        fault.write_attempts,
        [(LOCKED_CACHE_BASE + line_offset as u32, 0)]
    );
    assert!(fault.locked_cache_page.iter().all(|byte| *byte == 0xa5));
    assert_eq!(fault.cpu.user.gpr[5], 0x55aa);
    assert_eq!(
        fault.cpu.supervisor.exception.dar,
        LOCKED_CACHE_BASE + line_offset as u32
    );
    assert_eq!(fault.cpu.supervisor.exception.dsisr, 0x4200_0000);
    assert_eq!(fault.cpu.supervisor.exception.srr[0], initial_pc);
    assert_eq!(fault.cpu.pc, Address(0xfff0_0300));
    assert_eq!(fault.exit_executed.instructions, 1);
    assert_eq!(fault.exit_executed.cycles, 2);
}

#[test]
fn native_lswx_observes_defined_counts_partial_faults_and_alignment_boundaries() {
    let indexed = lswx(1, 0, 0);
    assert_eq!(indexed.op, Opcode::Lswx);
    for isa in [
        jitclif::isa::x86_64_v1(),
        jitclif::isa::x86_64_v3(),
        jitclif::isa::aarch64(),
    ] {
        let (_, meta) = compile_sequence(isa, Sequence(vec![indexed]));
        assert_eq!(meta.seq.0, [indexed]);
        assert_eq!(meta.cycles, 10);
    }

    // This trailing instruction must be left for the next translation because lswx has a
    // runtime-selected destination range and therefore ends the current register-cache epoch.
    let trailing = Ins::new(0x3863_0001, Extensions::gekko_broadway());

    let mut hooks = unsafe { Hooks::stub() };
    hooks.get_registers = native_lswx_registers;
    hooks.get_fastmem = native_lswx_fastmem;
    hooks.read_i8 = native_lswx_read_i8;
    hooks.exit = native_lswx_exit;
    let mut jit = Jit::new(
        Settings {
            codegen: CodegenSettings::default(),
            cache_path: None,
            exit_data_layout: Layout::new::<u8>(),
        },
        hooks,
    );
    let block = jit.build([indexed, trailing].into_iter()).unwrap();
    assert_eq!(block.meta().seq.0, [indexed]);
    assert_eq!(block.meta().cycles, 10);

    let bytes = std::array::from_fn(|index| (index as u8).wrapping_mul(37).wrapping_add(11));
    let mut context = NativeLswxContext {
        cpu: Cpu::default(),
        fastmem: Box::new([None; FASTMEM_LUT_COUNT]),
        bytes,
        reads: Vec::new(),
        fail_at: None,
        exit_executed: Executed::default(),
    };
    let initial_pc = 0x8000_5000;

    // r1 through r31 can receive at most 124 bytes without overlapping the r0/r0 address
    // operands. This covers every architecturally defined XER count for this instruction form;
    // counts 125 through 127 necessarily cover all GPRs and are boundedly undefined.
    for count in 0u32..=124 {
        let mut initial = std::array::from_fn(|index| 0xa500_0000 | index as u32);
        initial[0] = 0x0000_2000;
        context.cpu = Cpu {
            pc: Address(initial_pc),
            ..Cpu::default()
        };
        context.cpu.user.gpr = initial;
        context.cpu.user.xer = XerReg::from_bits(0xc000_0000 | count);
        context.reads.clear();
        context.fail_at = None;
        context.exit_executed = Executed::default();

        unsafe {
            jit.call((&raw mut context).cast::<Context>(), block.as_ptr());
        }

        let mut expected = initial;
        for index in 0..count as usize {
            let register = 1 + index / 4;
            let shift = 8 * (3 - index % 4);
            if index % 4 == 0 {
                expected[register] = 0;
            }
            expected[register] |= u32::from(bytes[index]) << shift;
        }
        assert_eq!(context.cpu.user.gpr, expected, "XER count {count}");
        assert_eq!(
            context.reads,
            (0..count).map(|offset| 0x2000 + offset).collect::<Vec<_>>(),
            "XER count {count}"
        );
        assert_eq!(context.cpu.user.xer.to_bits(), 0xc000_0000 | count);
        assert_eq!(context.cpu.pc, Address(initial_pc + 4));
        assert_eq!(context.exit_executed.instructions, 1);
        assert_eq!(context.exit_executed.cycles, 10);
    }

    // Counts 125 through 127 necessarily make the destination range overlap r0, the indexed
    // address operand. Their register results are architecturally undefined, but execution
    // remains bounded: the implementation latches EA and issues exactly the selected byte count.
    for count in 125u32..=127 {
        context.cpu = Cpu {
            pc: Address(initial_pc),
            ..Cpu::default()
        };
        context.cpu.user.gpr[0] = 0x0000_2000;
        context.cpu.user.xer = XerReg::from_bits(0x4000_0000 | count);
        context.reads.clear();
        context.fail_at = None;
        context.exit_executed = Executed::default();

        unsafe {
            jit.call((&raw mut context).cast::<Context>(), block.as_ptr());
        }

        assert_eq!(
            context.reads,
            (0..count).map(|offset| 0x2000 + offset).collect::<Vec<_>>(),
            "boundedly undefined XER count {count}"
        );
        assert_eq!(context.cpu.user.xer.to_bits(), 0x4000_0000 | count);
        assert_eq!(context.cpu.pc, Address(initial_pc + 4));
        assert_eq!(context.exit_executed.instructions, 1);
        assert_eq!(context.exit_executed.cycles, 10);
    }

    // Exercise EA addition while the destination register range wraps r31-r0.
    let wrapping = lswx(30, 3, 4);
    let wrapping_block = jit.build([wrapping].into_iter()).unwrap();
    let mut initial = std::array::from_fn(|index| 0x5a00_0000 | index as u32);
    initial[3] = 0x0000_2ff0;
    initial[4] = 0x0000_0010;
    context.cpu = Cpu {
        pc: Address(initial_pc),
        ..Cpu::default()
    };
    context.cpu.user.gpr = initial;
    context.cpu.user.xer = XerReg::from_bits(0x8000_000a);
    context.reads.clear();
    context.fail_at = None;
    unsafe {
        jit.call(
            (&raw mut context).cast::<Context>(),
            wrapping_block.as_ptr(),
        );
    }
    let mut expected = initial;
    for (index, byte) in bytes[..10].iter().copied().enumerate() {
        let register = (30 + index / 4) % 32;
        let shift = 8 * (3 - index % 4);
        if index % 4 == 0 {
            expected[register] = 0;
        }
        expected[register] |= u32::from(byte) << shift;
    }
    assert_eq!(context.cpu.user.gpr, expected);
    assert_eq!(
        context.reads,
        [
            0x3000, 0x3001, 0x3002, 0x3003, 0x3004, 0x3005, 0x3006, 0x3007, 0x3008, 0x3009
        ]
    );

    // PowerPC permits partial multiple/string loads. Match the MPC750's discrete accesses and
    // Dolphin's Gekko behavior by retaining successful bytes but not the faulting byte.
    let fault_initial = initial;
    context.cpu = Cpu {
        pc: Address(initial_pc),
        ..Cpu::default()
    };
    context.cpu.user.gpr = fault_initial;
    context.cpu.user.gpr[3] = 0x3000;
    context.cpu.user.gpr[4] = 0x20;
    let fault_initial = context.cpu.user.gpr;
    context.cpu.user.xer = XerReg::from_bits(7);
    context.reads.clear();
    context.fail_at = Some(6);
    context.exit_executed = Executed::default();
    unsafe {
        jit.call(
            (&raw mut context).cast::<Context>(),
            wrapping_block.as_ptr(),
        );
    }
    let mut fault_expected = fault_initial;
    fault_expected[30] = bytes[..4]
        .iter()
        .fold(0u32, |word, byte| word << 8 | u32::from(*byte));
    fault_expected[31] = u32::from(bytes[4]) << 24 | u32::from(bytes[5]) << 16;
    assert_eq!(context.cpu.user.gpr, fault_expected);
    assert_eq!(
        context.reads,
        [0x3020, 0x3021, 0x3022, 0x3023, 0x3024, 0x3025, 0x3026]
    );
    assert_eq!(context.cpu.supervisor.exception.dar, 0x3026);
    assert_eq!(context.cpu.supervisor.exception.dsisr, 0x4200_0000);
    assert_eq!(context.cpu.supervisor.exception.srr[0], initial_pc);
    assert_eq!(context.cpu.pc, Address(0xfff0_0300));
    assert_eq!(context.exit_executed.instructions, 1);
    assert_eq!(context.exit_executed.cycles, 10);

    // MPC750 detects both string-range boundary cases before issuing a memory access.
    for (base, count) in [(0x0000_0ffdu32, 4u32), (0x0fff_fffcu32, 8u32)] {
        context.cpu = Cpu {
            pc: Address(initial_pc),
            ..Cpu::default()
        };
        context.cpu.user.gpr = fault_initial;
        context.cpu.user.gpr[3] = base;
        context.cpu.user.gpr[4] = 0;
        let boundary_initial = context.cpu.user.gpr;
        context.cpu.user.xer = XerReg::from_bits(count);
        context.reads.clear();
        context.fail_at = None;
        context.exit_executed = Executed::default();
        unsafe {
            jit.call(
                (&raw mut context).cast::<Context>(),
                wrapping_block.as_ptr(),
            );
        }
        assert_eq!(context.cpu.user.gpr, boundary_initial);
        assert!(context.reads.is_empty());
        assert_eq!(context.cpu.supervisor.exception.dar, base);
        assert_eq!(context.cpu.supervisor.exception.dsisr, 0x0000_a3c3);
        assert_eq!(context.cpu.supervisor.exception.srr[0], initial_pc);
        assert_eq!(context.cpu.pc, Address(0xfff0_0600));
        assert_eq!(context.exit_executed.instructions, 1);
        assert_eq!(context.exit_executed.cycles, 10);
    }

    // Zero has literal zero-byte semantics and cannot manufacture a crossing exception.
    context.cpu = Cpu {
        pc: Address(initial_pc),
        ..Cpu::default()
    };
    context.cpu.user.gpr = fault_initial;
    context.cpu.user.gpr[3] = 0x0fff_ffff;
    context.cpu.user.gpr[4] = 0;
    let zero_initial = context.cpu.user.gpr;
    context.cpu.user.xer = XerReg::from_bits(0);
    context.reads.clear();
    context.fail_at = None;
    context.exit_executed = Executed::default();
    unsafe {
        jit.call(
            (&raw mut context).cast::<Context>(),
            wrapping_block.as_ptr(),
        );
    }
    assert_eq!(context.cpu.user.gpr, zero_initial);
    assert!(context.reads.is_empty());
    assert_eq!(context.cpu.pc, Address(initial_pc + 4));
    assert_eq!(context.exit_executed.instructions, 1);
    assert_eq!(context.exit_executed.cycles, 10);

    // String loads in little-endian mode raise Alignment before translation or memory access.
    context.cpu = Cpu {
        pc: Address(initial_pc),
        ..Cpu::default()
    };
    context.cpu.user.gpr = fault_initial;
    context.cpu.user.gpr[3] = 0x4000;
    context.cpu.user.gpr[4] = 0x20;
    let alignment_initial = context.cpu.user.gpr;
    context.cpu.user.xer = XerReg::from_bits(7);
    context.cpu.supervisor.config.msr = context
        .cpu
        .supervisor
        .config
        .msr
        .clone()
        .with_little_endian(true);
    context.reads.clear();
    context.fail_at = None;
    context.exit_executed = Executed::default();
    unsafe {
        jit.call(
            (&raw mut context).cast::<Context>(),
            wrapping_block.as_ptr(),
        );
    }
    assert_eq!(context.cpu.user.gpr, alignment_initial);
    assert!(context.reads.is_empty());
    assert_eq!(context.cpu.supervisor.exception.dar, 0x4020);
    assert_eq!(context.cpu.supervisor.exception.dsisr, 0x0000_a3c3);
    assert_eq!(context.cpu.supervisor.exception.srr[0], initial_pc);
    assert_eq!(context.cpu.pc, Address(0xfff0_0600));
    assert_eq!(context.exit_executed.instructions, 1);
    assert_eq!(context.exit_executed.cycles, 10);
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
