// Single-slot toast. setToast('msg', 'ok'|'error') schedules an auto-hide.

import { signal } from '@preact/signals';

export const toastState = signal({ msg: '', kind: 'ok', visible: false });
let timer = null;

export function setToast(msg, kind = 'ok') {
  toastState.value = { msg, kind, visible: true };
  clearTimeout(timer);
  timer = setTimeout(() => {
    toastState.value = { ...toastState.value, visible: false };
  }, 3200);
}
