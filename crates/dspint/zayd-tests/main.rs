#![feature(trim_prefix_suffix)]

mod file;

use std::fmt::Write;

use dspint::{DspBus, DspControl, DspDma, DspMailbox, Interpreter, Registers};
use libtest_mimic::{Arguments, Failed, Trial};

struct TestBus {
    control: DspControl,
    dma: DspDma,
    dsp_mailbox: DspMailbox,
    cpu_mailbox: DspMailbox,
    main_ram: Vec<u8>,
    aram: Vec<u8>,
}

impl Default for TestBus {
    fn default() -> Self {
        Self {
            control: DspControl {
                reset_high: false,
                ..DspControl::default()
            },
            dma: DspDma::default(),
            dsp_mailbox: DspMailbox::default(),
            cpu_mailbox: DspMailbox::default(),
            main_ram: vec![0; 0x1000],
            aram: vec![0; 0x0100_0000],
        }
    }
}

impl DspBus for TestBus {
    fn dsp_control(&self) -> DspControl {
        self.control
    }

    fn set_dsp_control(&mut self, control: DspControl) {
        self.control = control;
    }

    fn dsp_dma(&self) -> DspDma {
        self.dma
    }

    fn set_dsp_dma(&mut self, dma: DspDma) {
        self.dma = dma;
    }

    fn dsp_mailbox(&self) -> DspMailbox {
        self.dsp_mailbox
    }

    fn set_dsp_mailbox(&mut self, mailbox: DspMailbox) {
        self.dsp_mailbox = mailbox;
    }

    fn cpu_mailbox(&self) -> DspMailbox {
        self.cpu_mailbox
    }

    fn set_cpu_mailbox(&mut self, mailbox: DspMailbox) {
        self.cpu_mailbox = mailbox;
    }

    fn main_ram(&self) -> &[u8] {
        &self.main_ram
    }

    fn main_ram_mut(&mut self) -> &mut [u8] {
        &mut self.main_ram
    }

    fn main_ram_write_completed(&mut self, _address: u32, _length: usize) {}

    fn aram(&self) -> &[u8] {
        &self.aram
    }

    fn aram_mut(&mut self) -> &mut [u8] {
        &mut self.aram
    }

    fn request_cpu_interrupt(&mut self) {}
}

fn parse_code(mut words: &[u16]) -> Vec<dspint::Ins> {
    let mut ins = vec![];
    while !words.is_empty() {
        let decoded = dspint::ins::Ins::new(words[0]).decoded();
        if decoded.opcode.needs_extra() {
            ins.push(dspint::Ins::with_extra(words[0], words[1]));
            words = &words[2..];
        } else {
            ins.push(dspint::Ins::new(words[0]));
            words = &words[1..];
        }
    }

    ins
}

struct FailedCase {
    code: Vec<dspint::Ins>,
    initial: Registers,
    expected: Registers,
    divergences: Vec<(dspint::Reg, u16, u16)>,
}

fn run_case(bus: &mut TestBus, case: file::TestCase) -> Result<(), FailedCase> {
    let mut dsp = Interpreter::default();

    // setup
    bus.control.halted = false;
    dsp.pc = 62;
    dsp.regs = case.initial_regs();
    dsp.mem.iram[62..][..case.instructions.len()].copy_from_slice(&case.instructions);
    dsp.mem.iram[62 + case.instructions.len()] = 0x21; // HALT

    // run until halt
    let code = parse_code(&case.instructions);
    while !bus.control.halted {
        dsp.step(bus);
    }

    // check
    let allow_status = std::env::var("IGNORE_STATUS").is_ok();
    let mut expected = case.expected_regs();
    let mut divergences = vec![];
    for i in 0..32 {
        let reg = dspint::Reg::new(i);
        let value = dsp.regs.get(reg);
        let expected = expected.get(reg);

        if value != expected {
            if allow_status && reg == dspint::Reg::Status {
                continue;
            }

            if reg == dspint::Reg::Config {
                continue;
            }

            divergences.push((reg, value, expected));
        }
    }

    if !divergences.is_empty() {
        return Err(FailedCase {
            code,
            initial: case.initial_regs(),
            expected: case.expected_regs(),
            divergences,
        });
    }

    Ok(())
}

fn run_test(file: file::TestFile, quiet: bool) -> Result<(), Failed> {
    let early_exit = std::env::var("EARLY_EXIT").is_ok();
    let total = file.cases.len();
    let mut failures = vec![];

    let mut bus = TestBus::default();

    for (i, case) in file.cases.into_iter().enumerate() {
        let Err(failure) = run_case(&mut bus, case) else {
            continue;
        };

        let mut pc = 62;
        let mut disasm = String::new();
        for ins in failure.code.iter() {
            writeln!(&mut disasm, "{pc:04X} {ins:?}").unwrap();
            pc += if ins.decoded().needs_extra { 2 } else { 1 };
        }

        let divergences = failure
            .divergences
            .iter()
            .map(|(r, v, e)| format!("{r:?}(v={v:04X}, e={e:04X}), "))
            .collect::<String>();

        if early_exit {
            failures.push(format!(
                "Case {i} failed:\r\nINITIAL: {:04X?}\r\nEXPECTED: {:04X?}\r\nDIVERGENCES: {}\r\nCODE:\r\n{disasm}",
                failure.initial,
                failure.expected,
                divergences.trim_suffix(", "),
            ));
            break;
        } else {
            failures.push(format!(
                "Case {i} failed: {}\r\n{}",
                divergences.trim_suffix(", "),
                disasm
            ));
        }
    }

    if !failures.is_empty() {
        if quiet {
            return Err(Failed::from(format!(
                "Failed a total of {} cases (out of {})",
                failures.len(),
                total
            )));
        }

        let mut msg = format!(
            "Failed a total of {} cases (out of {})\r\n\r\n",
            failures.len(),
            total
        );
        let tests_to_show = 8;

        let show = failures.iter().take(tests_to_show);
        for failure in show {
            writeln!(&mut msg, "{}", failure).unwrap();
        }

        if failures.len() > tests_to_show {
            writeln!(
                &mut msg,
                "... and {} others",
                failures.len() - tests_to_show
            )
            .unwrap();
        }

        return Err(Failed::from(msg));
    }

    Ok(())
}

fn main() {
    let manifest = env!("CARGO_MANIFEST_DIR");
    let tests_dir = std::fs::read_dir(format!("{manifest}/zayd-tests/tests")).unwrap();
    let args = Arguments::from_args();
    let env_quiet = std::env::var("QUIET").is_ok();

    let mut tests = vec![];
    for test in tests_dir {
        let test = test.unwrap();
        if test.file_type().unwrap().is_file() {
            let file = file::TestFile::open(test.path());
            tests.push(Trial::test(
                test.file_name().to_string_lossy().into_owned(),
                move || {
                    let result =
                        std::panic::catch_unwind(move || run_test(file, args.quiet || env_quiet));

                    match result {
                        Ok(r) => r,
                        Err(e) => {
                            let mut msg = "<unknown panic>".to_owned();
                            if let Some(s) = e.downcast_ref::<String>() {
                                msg = s.clone();
                            } else if let Some(s) = e.downcast_ref::<&'static str>() {
                                msg = (*s).to_owned();
                            }

                            Err(Failed::from(msg))
                        }
                    }
                },
            ));
        }
    }

    std::panic::set_hook(Box::new(move |_| ()));
    libtest_mimic::run(&args, tests).exit();
}
