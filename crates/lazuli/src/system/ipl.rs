use std::ffi::CStr;
use std::ops::{Deref, DerefMut};

use crate::system::mem;

pub(crate) const BUNDLED_FONT_JAPANESE_OFFSET: usize = 0x1a_ff00;
pub(crate) const BUNDLED_FONT_WESTERN_OFFSET: usize = 0x1f_cf00;

const BUNDLED_FONT_JAPANESE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../resources/ipl/font_japanese.bin"
));
const BUNDLED_FONT_WESTERN: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../resources/ipl/font_western.bin"
));

const _: () = assert!(
    BUNDLED_FONT_JAPANESE_OFFSET + BUNDLED_FONT_JAPANESE.len() <= BUNDLED_FONT_WESTERN_OFFSET
);
const _: () = assert!(BUNDLED_FONT_WESTERN_OFFSET + BUNDLED_FONT_WESTERN.len() <= mem::IPL_LEN);

/// IPL decoding function, thanks @hazelwiss!!
fn decode_ipl(ipl: &mut [u8]) {
    let mut acc = 0u8;
    let mut nacc = 0u8;

    let mut t = 0x2953u16;
    let mut u = 0xD9C2u16;
    let mut v = 0x3FF1u16;

    let mut x = 1u8;

    let mut it = 0;
    while it < ipl.len() {
        let t0 = t as u8 & 1;
        let t1 = (t as u8 >> 1) & 1;
        let u0 = u as u8 & 1;
        let u1 = (u as u8 >> 1) & 1;
        let v0 = v as u8 & 1;

        x ^= t1 ^ v0;
        x ^= u0 | u1;
        x ^= (t0 ^ u1 ^ v0) & (t0 ^ u0);

        if t0 == u0 {
            v >>= 1;
            if v0 != 0 {
                v ^= 0xb3d0;
            }
        }

        if t0 == 0 {
            u >>= 1;
            if u0 != 0 {
                u ^= 0xfb10;
            }
        }

        t >>= 1;
        if t0 != 0 {
            t ^= 0xa740;
        }

        nacc += 1;
        acc = acc.wrapping_mul(2).wrapping_add(x);
        if nacc == 8 {
            ipl[it] ^= acc;
            it += 1;
            nacc = 0;
        }
    }
}

pub struct Ipl(Vec<u8>);

impl Ipl {
    pub fn new(mut data: Vec<u8>) -> Self {
        prepare(&mut data);
        Self(data)
    }

    /// Constructs the redistributable sparse IPL-compatible image used by the browser path.
    pub(crate) fn bundled_default() -> Self {
        let mut data = vec![0; mem::IPL_LEN];
        install_bundled_default(&mut data);
        Self(data)
    }
}

/// Installs the same decoded sparse replacement-font image as the established browser frontend.
///
/// These bytes are already in the console's decoded IPL address space and must never pass through
/// the retail descrambler.
pub(super) fn install_bundled_default(data: &mut [u8]) {
    assert_eq!(data.len(), mem::IPL_LEN);
    data.fill(0);
    data[BUNDLED_FONT_JAPANESE_OFFSET..][..BUNDLED_FONT_JAPANESE.len()]
        .copy_from_slice(BUNDLED_FONT_JAPANESE);
    data[BUNDLED_FONT_WESTERN_OFFSET..][..BUNDLED_FONT_WESTERN.len()]
        .copy_from_slice(BUNDLED_FONT_WESTERN);
}

/// Validates and decodes one complete IPL image in place.
pub(super) fn prepare(data: &mut [u8]) {
    assert_eq!(data.len(), mem::IPL_LEN);

    let ipl_message = CStr::from_bytes_until_nul(data).unwrap();
    let pal_message = "(C) 1999-2001 Nintendo.  All rights reserved.(C) 1999 ArtX Inc.  All rights reserved.PAL  Revision 1.0  ";
    if ipl_message.to_str().is_ok_and(|s| s == pal_message) {
        tracing::info!("IPL was detected as EU/PAL.");
        decode_ipl(&mut data[0x0000_0100..0x001A_EEE8]);
    } else {
        tracing::info!("IPL was not detected as EU/PAL. Assuming USA/NTSC.");
        decode_ipl(&mut data[0x0000_0100..0x0015_EE40]);
    }
}

impl Deref for Ipl {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl DerefMut for Ipl {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    use super::*;

    #[test]
    fn bundled_fonts_are_pinned_and_installed_at_the_legacy_offsets() {
        assert_eq!(BUNDLED_FONT_JAPANESE.len(), 259_626);
        assert_eq!(BUNDLED_FONT_WESTERN.len(), 6_478);
        assert_eq!(
            format!("{:x}", Sha256::digest(BUNDLED_FONT_JAPANESE)),
            "38f9f59d505bc4e2d86b0196706195f33ad72b7fe9d029cf263072cde19d044f"
        );
        assert_eq!(
            format!("{:x}", Sha256::digest(BUNDLED_FONT_WESTERN)),
            "4ad991be2b0aa305f09b90a79fc50f57833b30b008890b5ef1336cc3d9d0bae0"
        );

        let ipl = Ipl::bundled_default();
        assert!(
            ipl[..BUNDLED_FONT_JAPANESE_OFFSET]
                .iter()
                .all(|byte| *byte == 0)
        );
        assert_eq!(
            &ipl[BUNDLED_FONT_JAPANESE_OFFSET..][..BUNDLED_FONT_JAPANESE.len()],
            BUNDLED_FONT_JAPANESE
        );
        assert!(
            ipl[BUNDLED_FONT_JAPANESE_OFFSET + BUNDLED_FONT_JAPANESE.len()
                ..BUNDLED_FONT_WESTERN_OFFSET]
                .iter()
                .all(|byte| *byte == 0)
        );
        assert_eq!(
            &ipl[BUNDLED_FONT_WESTERN_OFFSET..][..BUNDLED_FONT_WESTERN.len()],
            BUNDLED_FONT_WESTERN
        );
        assert!(
            ipl[BUNDLED_FONT_WESTERN_OFFSET + BUNDLED_FONT_WESTERN.len()..]
                .iter()
                .all(|byte| *byte == 0)
        );
    }
}
