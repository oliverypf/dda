import assert from 'node:assert/strict';
import test from 'node:test';

import { preferMappedPath } from '../src/windows-path.mjs';

test('maps an exact UNC server/share root back to its mapped drive', () => {
  const mappings = [{ drive: 'Z', root: '\\\\hwfs\\文档' }];
  assert.equal(
    preferMappedPath('\\\\hwfs\\文档\\DevEcoStudioProjects\\hmCodex', {
      platform: 'win32',
      mappings
    }),
    'Z:\\DevEcoStudioProjects\\hmCodex'
  );
});

test('does not map a UNC path through an unrelated share', () => {
  assert.equal(
    preferMappedPath('\\\\hwfs\\其他\\hmCodex', {
      platform: 'win32',
      mappings: [{ drive: 'Z', root: '\\\\hwfs\\文档' }]
    }),
    '\\\\hwfs\\其他\\hmCodex'
  );
});

test('keeps an explicitly mapped drive spelling unchanged', () => {
  assert.equal(
    preferMappedPath('Z:/DevEcoStudioProjects/hmCodex', {
      platform: 'win32',
      mappings: [{ drive: 'Z', root: '\\\\hwfs\\文档' }]
    }),
    'Z:/DevEcoStudioProjects/hmCodex'
  );
});

test('does not apply Windows mapping rules on another platform', () => {
  const unc = '//hwfs/文档/DevEcoStudioProjects/hmCodex';
  assert.equal(
    preferMappedPath(unc, {
      platform: 'linux',
      mappings: [{ drive: 'Z', root: '\\\\hwfs\\文档' }]
    }),
    unc
  );
});
