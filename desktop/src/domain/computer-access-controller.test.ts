import { describe, expect, it, vi } from 'vitest';
import { ComputerAccessController } from './computer-access-controller';
import type { AccessStatus } from './computer-access';

const status = (mode: 'REQUIRE_APPROVAL' | 'FULL_ACCESS'): AccessStatus => ({ mode, scope: 'USER_FILESYSTEM', updatedAtMs: 1 });

const make = (read = async () => status('REQUIRE_APPROVAL'), write = async (m: 'REQUIRE_APPROVAL' | 'FULL_ACCESS') => status(m)) => {
  const onChange = vi.fn();
  const controller = new ComputerAccessController({ read, write, onChange });
  return { controller, onChange };
};

describe('ComputerAccessController', () => {
  it('loads FULL_ACCESS status on startup', async () => {
    const { controller } = make(async () => status('FULL_ACCESS'));
    await controller.load();
    expect(controller.mode).toBe('FULL_ACCESS');
  });

  it('malformed or thrown read fails closed with an error', async () => {
    const { controller } = make(async () => ({ mode: 'BANANA' } as unknown as AccessStatus));
    await controller.load();
    expect(controller.mode).toBe('REQUIRE_APPROVAL');
    expect(controller.state.error).toBeTruthy();
    const { controller: thrown } = make(async () => { throw new Error('io'); });
    await thrown.load();
    expect(thrown.mode).toBe('REQUIRE_APPROVAL');
    expect(thrown.state.error).toBeTruthy();
  });

  it('enable(false) makes no IPC call', async () => {
    const write = vi.fn(async () => status('FULL_ACCESS'));
    const { controller } = make(async () => status('REQUIRE_APPROVAL'), write);
    expect(await controller.enable(false)).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('enable(true) writes confirmed FULL_ACCESS and updates the badge', async () => {
    const write = vi.fn(async () => status('FULL_ACCESS'));
    const { controller } = make(async () => status('REQUIRE_APPROVAL'), write);
    await controller.load();
    expect(await controller.enable(true)).toBe(true);
    expect(write).toHaveBeenCalledWith('FULL_ACCESS', true);
    expect(controller.mode).toBe('FULL_ACCESS');
  });

  it('disable writes REQUIRE_APPROVAL without confirmation', async () => {
    const write = vi.fn(async () => status('REQUIRE_APPROVAL'));
    const { controller } = make(async () => status('FULL_ACCESS'), write);
    await controller.load();
    expect(await controller.disable()).toBe(true);
    expect(write).toHaveBeenCalledWith('REQUIRE_APPROVAL', false);
    expect(controller.mode).toBe('REQUIRE_APPROVAL');
  });

  it('save failure keeps the old status and surfaces an error', async () => {
    const write = vi.fn(async () => { throw new Error('denied'); });
    const { controller } = make(async () => status('FULL_ACCESS'), write);
    await controller.load();
    expect(await controller.disable()).toBe(false);
    expect(controller.mode).toBe('FULL_ACCESS');
    expect(controller.state.error).toBeTruthy();
  });

  it('in-flight duplicate clicks produce no second IPC', async () => {
    let resolveWrite: ((v: AccessStatus) => void) | undefined;
    const write = vi.fn(() => new Promise<AccessStatus>((r) => { resolveWrite = r; }));
    const { controller } = make(async () => status('REQUIRE_APPROVAL'), write);
    await controller.load();
    const first = controller.enable(true);
    const second = controller.enable(true);
    resolveWrite?.(status('FULL_ACCESS'));
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('enable is refused while a load is in flight (no stale-load race)', async () => {
    let resolveRead: ((v: AccessStatus) => void) | undefined;
    const write = vi.fn(async () => status('FULL_ACCESS'));
    const read = vi.fn(() => new Promise<AccessStatus>((r) => { resolveRead = r; }));
    const { controller } = make(read, write);
    const load = controller.load();
    const enable = controller.enable(true);
    resolveRead?.(status('REQUIRE_APPROVAL'));
    await Promise.all([enable, load]);
    expect(write).not.toHaveBeenCalled();
    expect(await enable === false || controller.mode === 'REQUIRE_APPROVAL').toBe(true);
  });

  it('load is skipped while a save is in flight', async () => {
    let resolveWrite: ((v: AccessStatus) => void) | undefined;
    const read = vi.fn(async () => status('REQUIRE_APPROVAL'));
    const write = vi.fn(() => new Promise<AccessStatus>((r) => { resolveWrite = r; }));
    const { controller } = make(read, write);
    await controller.load();
    read.mockClear();
    const enable = controller.enable(true);
    await controller.load();
    resolveWrite?.(status('FULL_ACCESS'));
    await enable;
    expect(read).not.toHaveBeenCalled();
    expect(controller.mode).toBe('FULL_ACCESS');
  });

  it('a read failure after a FULL load clears the badge', async () => {
    let fail = false;
    const read = vi.fn(async () => { if (fail) throw new Error('io'); return status('FULL_ACCESS'); });
    const { controller } = make(read);
    await controller.load();
    expect(controller.mode).toBe('FULL_ACCESS');
    fail = true;
    await controller.load();
    expect(controller.mode).toBe('REQUIRE_APPROVAL');
    expect(controller.state.error).toBeTruthy();
  });
});
