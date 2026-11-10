import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { replacePathVariables } from './helpers.js';
import { ToolError } from './tool-error.js';

describe('replacePathVariables', () => {
  it('fills exact names in both bracket styles', () => {
    assert.equal(replacePathVariables('/tickets/{{ticketId}}/comments/{id}', { ticketId: 42, id: 'c 1' }), '/tickets/42/comments/c%201');
  });

  it('matches a variable regardless of case, underscores and hyphens', () => {
    for (const key of ['ticket_id', 'TICKET_ID', 'ticket-id', 'TicketId']) {
      assert.equal(replacePathVariables('/api/v2/tickets/{{ticketId}}', { [key]: 48213 }), '/api/v2/tickets/48213', key);
    }
    assert.equal(replacePathVariables('/repos/{owner}/{repo}/pulls/{{pullNumber}}', { owner: 'acme', repo: 'web', pull_number: 517 }), '/repos/acme/web/pulls/517');
  });

  it('prefers the exact name over a loose match', () => {
    assert.equal(replacePathVariables('/x/{{ticketId}}', { ticket_id: 'loose', ticketId: 'exact' }), '/x/exact');
  });

  it('names every expected variable when one is missing', () => {
    assert.throws(
      () => replacePathVariables('/repos/{{owner}}/{{repo}}/pulls/{{pullNumber}}', { owner: 'acme', repo: 'web' }),
      /Missing value for path variable: pullNumber\..*pass pathVariables with: owner, repo, pullNumber\./
    );
  });

  it('leaves a path without variables untouched, even with no variables given', () => {
    assert.equal(replacePathVariables('/v1/gmail/send-email', {}), '/v1/gmail/send-email');
  });

  it('rejects empty values', () => {
    assert.throws(() => replacePathVariables('/x/{{id}}', { id: '' }), /Missing value for path variable: id/);
  });

  it('refuses a value that would become a dot segment', () => {
    for (const value of ['.', '..']) {
      assert.throws(() => replacePathVariables('/a/{{id}}/b', { id: value }), ToolError, value);
    }
  });

  it('refuses dot segments assembled from adjacent variables', () => {
    assert.throws(() => replacePathVariables('/a/{{x}}{{y}}/b', { x: '.', y: '.' }), ToolError);
  });

  it('keeps values that only contain dots', () => {
    assert.equal(replacePathVariables('/a/{{x}}/{{y}}/{{z}}', { x: '...', y: '..hidden', z: 'file.txt' }), '/a/.../..hidden/file.txt');
  });

  it('keeps a value with a slash inside one encoded segment', () => {
    assert.equal(replacePathVariables('/a/{{x}}', { x: '../..' }), '/a/..%2F..');
  });

  it('allows dots in a variable after the query separator', () => {
    assert.equal(replacePathVariables('/a?q={{q}}', { q: '..' }), '/a?q=..');
  });
});
