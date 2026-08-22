use browser_machine::disc_boot::{
    BrowserDiscBootError, BrowserDiscBootState, BrowserDiscBootStatus,
};
use lazuli::disks::async_boot::{
    BootError, BootReaderStage, CISO_HEADER_BYTES, ReadCompletionError,
};

#[test]
fn rust_owner_rotates_epochs_across_cancelled_boots() {
    let mut state = BrowserDiscBootState::default();
    assert_eq!(state.begin(u64::from(CISO_HEADER_BYTES)).unwrap(), 1);
    let stale = state.requests().next().unwrap();
    assert!(state.cancel());
    assert_eq!(state.begin(u64::from(CISO_HEADER_BYTES)).unwrap(), 2);
    let current = state.requests().next().unwrap();
    assert_eq!(stale.id, current.id);
    assert_eq!(stale.container_offset, current.container_offset);
    assert_eq!(stale.length, current.length);
    assert_ne!(stale.epoch, current.epoch);
    assert!(matches!(
        state.staging_mut(stale),
        Err(BrowserDiscBootError::Completion(
            ReadCompletionError::DescriptorMismatch { .. }
        ))
    ));
    assert_eq!(state.requests().next(), Some(current));
}

#[test]
fn active_boot_cannot_be_replaced_implicitly() {
    let mut state = BrowserDiscBootState::default();
    state.begin(u64::from(CISO_HEADER_BYTES)).unwrap();
    assert_eq!(
        state.begin(u64::from(CISO_HEADER_BYTES)),
        Err(BrowserDiscBootError::ActiveBoot)
    );
    assert_eq!(state.stage(), Some(BootReaderStage::ContainerHeader));
}

#[test]
fn format_failure_remains_rust_owned_and_inspectable() {
    let source = vec![0; CISO_HEADER_BYTES as usize];
    let mut state = BrowserDiscBootState::default();
    state.begin(source.len() as u64).unwrap();
    let request = state.requests().next().unwrap();
    state.staging_mut(request).unwrap().copy_from_slice(&source);
    assert_eq!(
        state.complete(request, request.length, &mut []),
        Err(BrowserDiscBootError::Boot(BootError::InvalidDiscMagic(0)))
    );
    assert_eq!(state.status(), BrowserDiscBootStatus::Failed);
    assert_eq!(state.stage(), Some(BootReaderStage::Failed));
    assert_eq!(state.failure(), Some(&BootError::InvalidDiscMagic(0)));
    assert!(state.plan().is_none());
    assert!(state.cancel());
}
