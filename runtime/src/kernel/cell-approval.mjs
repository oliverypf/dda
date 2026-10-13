/**
 * Cell effect approvals digest code + cellOpIndex + the host.request payload
 * together with the capability/request pair. `fingerprint` is that same digest
 * shown in the approval fold; callers compare `requestDigest` only.
 */

export const CELL_EFFECT_APPROVAL_TTL_MS = 120_000;
const CODE_PREVIEW_CHARS = 240;

export const approvalSubject = ({ capability, request, context } = {}) => {
  const cell = context?.cellApproval;
  if (!cell || typeof cell !== 'object') return { capability, request };
  return {
    capability,
    request,
    code: typeof cell.code === 'string' ? cell.code : '',
    cellOpIndex: Number.isInteger(cell.cellOpIndex) ? cell.cellOpIndex : 0,
    hostRequest: cell.hostRequest ?? null
  };
};

export const cellApprovalPresentation = (requestDigest, cell = {}) => {
  const code = typeof cell.code === 'string' ? cell.code : '';
  return {
    cellOpIndex: Number.isInteger(cell.cellOpIndex) ? cell.cellOpIndex : undefined,
    fingerprint: requestDigest,
    codePreview: code.length > CODE_PREVIEW_CHARS ? `${code.slice(0, CODE_PREVIEW_CHARS)}…` : code
  };
};
