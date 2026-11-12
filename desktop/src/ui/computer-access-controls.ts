// Composer pill + anchored popover + risk dialog for the global access mode.
// Pure DOM, no innerHTML of user data; the Rust backend is the sole writer.

import { ComputerAccessController } from '../domain/computer-access-controller';
import {
  ACCESS_MODAL_TITLE, ACCESS_MODAL_INTRO, ACCESS_CAPABILITY_CARDS,
  ACCESS_MODAL_BOUNDARY, ACCESS_MODAL_CHECKBOX,
  ACCESS_POPOVER_HEADING, ACCESS_POPOVER_SCOPE, ACCESS_PILL_ON, ACCESS_PILL_OFF
} from '../domain/computer-access';

export interface ComputerAccessControls {
  buttonHTML(id: string): string;
  settingsHTML(): string;
  open(trigger: HTMLElement): void;
  modalOpen(): boolean;
}

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SVG_ICONS: Record<string, string> = {
  file: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>',
  terminal: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  globe: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>'
};

export const createComputerAccessControls = ({ controller, isNative, onRender }: {
  controller: ComputerAccessController;
  isNative: () => boolean;
  onRender: () => void;
}): ComputerAccessControls => {
  let popover: HTMLElement | undefined;
  let modal: HTMLDialogElement | undefined;
  let submitting = false;
  let onDocumentClick: ((e: MouseEvent) => void) | undefined;
  let onKey: ((e: KeyboardEvent) => void) | undefined;

  const closePopover = () => {
    popover?.remove();
    popover = undefined;
    if (onDocumentClick) document.removeEventListener('click', onDocumentClick, true);
    if (onKey) document.removeEventListener('keydown', onKey);
    onDocumentClick = onKey = undefined;
  };

  const positionPopover = (trigger: HTMLElement) => {
    if (!popover) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 24);
    popover.style.width = `${width}px`;
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    popover.style.left = `${left}px`;
    const height = popover.offsetHeight;
    const above = window.innerHeight - rect.top + 8 + height <= window.innerHeight - 12;
    if (above) {
      popover.style.bottom = `${window.innerHeight - rect.top + 8}px`;
      popover.style.top = '';
    } else {
      const top = Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - height - 12));
      popover.style.top = `${top}px`;
      popover.style.bottom = '';
    }
  };

  const openPopover = (trigger: HTMLElement) => {
    if (!isNative() || controller.state.saving || controller.state.loading || submitting) return;
    closePopover();
    const { mode } = controller;
    const status = controller.state;
    popover = document.createElement('div');
    popover.className = 'access-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', ACCESS_POPOVER_HEADING);
    popover.innerHTML = `
      <p class="access-popover-heading">${esc(ACCESS_POPOVER_HEADING)}</p>
      <p class="access-popover-scope">${esc(ACCESS_POPOVER_SCOPE)}</p>
      <div class="access-popover-row">
        <span>${esc(mode === 'FULL_ACCESS' ? ACCESS_PILL_ON : ACCESS_PILL_OFF)}</span>
        <button type="button" role="switch" aria-checked="${mode === 'FULL_ACCESS'}" class="access-switch ${mode === 'FULL_ACCESS' ? 'is-on' : ''}" aria-label="切换访问模式" ${status.saving || status.loading ? 'disabled' : ''}></button>
      </div>
      <p class="access-popover-error" role="alert" ${status.error ? '' : 'hidden'}>${esc(status.error ?? '')}</p>`;
    document.body.append(popover);
    positionPopover(trigger);
    const switchEl = popover.querySelector('.access-switch');
    switchEl?.addEventListener('click', async () => {
      if (controller.mode === 'FULL_ACCESS') {
        const ok = await controller.disable();
        if (ok) { closePopover(); onRender(); }
        else if (popover) {
          const errorEl = popover.querySelector<HTMLElement>('.access-popover-error');
          if (errorEl) { errorEl.textContent = controller.state.error ?? '修改失败，原模式未改变'; errorEl.hidden = false; }
          onRender();
        }
      } else {
        closePopover();
        openModal(trigger);
      }
    });
    onDocumentClick = (e) => { if (!popover?.contains(e.target as Node) && !trigger.contains(e.target as Node)) closePopover(); };
    onKey = (e) => {
      if (e.key === 'Escape') {
        closePopover();
        document.getElementById(trigger.id)?.focus();
      }
    };
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('keydown', onKey);
  };

  const openModal = (trigger: HTMLElement) => {
    if (modal || submitting || !isNative()) return;
    const headingId = `access-modal-heading-${Math.random().toString(36).slice(2, 9)}`;
    modal = document.createElement('dialog');
    modal.className = 'access-modal';
    modal.setAttribute('aria-labelledby', headingId);
    const cards = ACCESS_CAPABILITY_CARDS.map((c) => `
      <div class="access-card">
        <span class="access-card-icon">${SVG_ICONS[c.icon] ?? SVG_ICONS.file}</span>
        <div><strong>${esc(c.title)}</strong><p>${esc(c.body)}</p></div>
      </div>`).join('');
    modal.innerHTML = `
      <form method="dialog" class="access-modal-body" novalidate>
        <div class="access-modal-head">
          <h3 id="${headingId}">${esc(ACCESS_MODAL_TITLE)}</h3>
          <button type="button" class="access-modal-close" aria-label="取消" data-close>×</button>
        </div>
        <p class="access-modal-intro">${esc(ACCESS_MODAL_INTRO)}</p>
        <div class="access-cards">${cards}</div>
        <p class="access-modal-boundary">${esc(ACCESS_MODAL_BOUNDARY)}</p>
        <label class="access-ack"><input type="checkbox" data-ack /> ${esc(ACCESS_MODAL_CHECKBOX)}</label>
        <p class="access-modal-error" role="alert" hidden></p>
        <div class="access-modal-actions">
          <button type="button" data-close>取消</button>
          <button type="button" class="access-confirm" data-confirm disabled>${esc(ACCESS_PILL_ON)}</button>
        </div>
      </form>`;
    document.body.append(modal);
    const ack = modal.querySelector<HTMLInputElement>('[data-ack]')!;
    const confirm = modal.querySelector<HTMLButtonElement>('[data-confirm]')!;
    const errorEl = modal.querySelector<HTMLElement>('.access-modal-error')!;
    const buttons = modal.querySelectorAll<HTMLButtonElement>('button');

    const setBusy = (busy: boolean) => {
      submitting = busy;
      ack.disabled = busy;
      buttons.forEach((b) => { b.disabled = busy; });
      if (!busy) confirm.disabled = !ack.checked;
    };

    ack.addEventListener('change', () => { confirm.disabled = submitting || !ack.checked; });
    modal.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', () => {
      if (submitting) return;
      modal?.close();
    }));
    modal.addEventListener('cancel', (e) => {
      e.preventDefault();
      if (!submitting) modal?.close();
    });
    // Backdrop click cancels only when no IPC is in flight and the click
    // landed outside the dialog's own rect.
    modal.addEventListener('click', (e) => {
      if (submitting || e.target !== modal) return;
      const rect = modal!.getBoundingClientRect();
      const outside = e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom;
      if (outside) modal?.close();
    });
    confirm.addEventListener('click', async () => {
      if (submitting || !ack.checked || controller.state.saving || controller.state.loading) return;
      setBusy(true);
      errorEl.hidden = true;
      const ok = await controller.enable(true);
      submitting = false;
      if (ok) {
        modal?.close();
        onRender();
      } else {
        ack.disabled = false;
        buttons.forEach((b) => { b.disabled = false; });
        confirm.disabled = !ack.checked;
        errorEl.textContent = controller.state.error ?? '修改失败，原模式未改变';
        errorEl.hidden = false;
      }
    });
    modal.addEventListener('close', () => {
      const el = modal;
      modal = undefined;
      el?.remove();
      document.getElementById(trigger.id)?.focus();
    }, { once: true });
    modal.showModal();
    ack.focus();
  };

  return {
    buttonHTML(id) {
      const { loading, saving, error } = controller.state;
      const mode = controller.mode;
      const busy = loading || saving || !isNative();
      const label = mode === 'FULL_ACCESS' ? ACCESS_PILL_ON : ACCESS_PILL_OFF;
      return `<button type="button" id="${esc(id)}" class="access-pill ${mode === 'FULL_ACCESS' ? 'is-on' : ''}" data-action="access-mode" ${busy ? 'disabled' : ''} aria-pressed="${mode === 'FULL_ACCESS'}" title="${esc(error ?? '')}">${esc(label)}</button>`;
    },
    settingsHTML() {
      const { loading, saving, error } = controller.state;
      const mode = controller.mode;
      const busy = loading || saving || !isNative();
      return `<div class="access-settings-card"><strong>${esc(ACCESS_POPOVER_HEADING)}</strong><p>${esc(ACCESS_POPOVER_SCOPE)}</p><div class="access-popover-row"><span data-access-mode-status>当前状态：${esc(mode === 'FULL_ACCESS' ? ACCESS_PILL_ON : ACCESS_PILL_OFF)}${error ? ` · ${esc(error)}` : ''}${loading || saving ? ' · 处理中' : ''}</span><button type="button" id="access-mode-settings" class="access-pill ${mode === 'FULL_ACCESS' ? 'is-on' : ''}" data-action="access-mode" ${busy ? 'disabled' : ''} aria-pressed="${mode === 'FULL_ACCESS'}">${esc(mode === 'FULL_ACCESS' ? ACCESS_PILL_ON : ACCESS_PILL_OFF)}</button></div></div>`;
    },
    open(trigger) {
      if (!isNative() || submitting) return;
      openPopover(trigger);
    },
    modalOpen() { return Boolean(modal); }
  };
};
