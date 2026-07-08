// Tests for explain-publish.mjs (#300): resolveBody が唯一の body 入口であること、
// verifyPublishedBody の「空の殻」判定、publishExplainDiscussion/addExplainComment が
// deps 注入下で body=材料内容を graphql に渡す（`@` literal を渡さないことを引数照合）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addExplainComment,
  findCategoryId,
  publishExplainDiscussion,
  resolveBody,
  verifyPublishedBody,
} from './explain-publish.mjs';

// --- resolveBody（唯一の body 入口） ---

test('resolveBody: file の中身を返す — @path 文字列は返さない', () => {
  const fakeRead = (file, encoding) => {
    assert.equal(encoding, 'utf8');
    return `# 材料本文\n\nfile=${file}\n`;
  };
  const body = resolveBody('explains/2026-07-08-issue300-x.md', { readFileSync: fakeRead });
  assert.match(body, /^# 材料本文/);
  assert.ok(!body.startsWith('@'), 'resolveBody は @path でなく中身を返す');
});

// --- verifyPublishedBody（publish 後 self-check） ---

test('verifyPublishedBody: 正常本文は PASS', () => {
  const material = '# Background\n\n本文がそれなりに長い教材の中身。'.repeat(10);
  assert.deepEqual(verifyPublishedBody(material, material), { ok: true });
  assert.deepEqual(verifyPublishedBody(`${material}\n\n追記`, material), { ok: true });
});

test('verifyPublishedBody: 空は FAIL', () => {
  const r = verifyPublishedBody('', '# 材料');
  assert.equal(r.ok, false);
  assert.match(r.reason, /empty/);
});

test('verifyPublishedBody: @explains 始まりは FAIL（#300 の空の殻の症状そのもの）', () => {
  const r = verifyPublishedBody('@explains/2026-07-08-issue281-x.md', '# 材料の中身は長い'.repeat(5));
  assert.equal(r.ok, false);
  assert.match(r.reason, /@explains/);
});

test('verifyPublishedBody: 材料より短いは FAIL（厳密 < ・等値は PASS）', () => {
  const material = '# 材料本文'.repeat(20);
  const shorter = verifyPublishedBody(material.slice(0, material.length - 1), material);
  assert.equal(shorter.ok, false);
  assert.match(shorter.reason, /shorter/);

  const equal = verifyPublishedBody(material, material);
  assert.equal(equal.ok, true, '等値（同じ長さ）は PASS — 契約は厳密 <');
});

// --- findCategoryId ---

test('findCategoryId: category 名（大小無視）から id を引く・無ければ null', () => {
  const data = {
    repository: {
      discussionCategories: { nodes: [{ id: 'CAT_1', name: 'Explain' }, { id: 'CAT_2', name: 'General' }] },
    },
  };
  assert.equal(findCategoryId(data, 'explain'), 'CAT_1');
  assert.equal(findCategoryId(data, 'General'), 'CAT_2');
  assert.equal(findCategoryId(data, 'Missing'), null);
  assert.equal(findCategoryId(null, 'Explain'), null);
});

// --- publishExplainDiscussion（deps 注入・body 引数照合） ---

function fakeReadFileSync(materialBody) {
  return () => materialBody;
}

test('publishExplainDiscussion: body=材料内容を -f（raw-field）で graphql に渡す（@ literal を渡さない）', () => {
  const materialBody = '# Background\n\n教材の中身。'.repeat(50);
  const calls = [];
  const spawnSync = (cmd, args) => {
    calls.push(args);
    assert.equal(cmd, 'gh');
    if (args.join(' ').includes('discussionCategories')) {
      return {
        status: 0,
        stdout: JSON.stringify({
          data: {
            repository: {
              id: 'REPO_ID_1',
              discussionCategories: { nodes: [{ id: 'CAT_EXPLAIN', name: 'Explain' }] },
            },
          },
        }),
      };
    }
    if (args.join(' ').includes('createDiscussion')) {
      const bodyArg = args.find((a) => a.startsWith('body='));
      return {
        status: 0,
        stdout: JSON.stringify({
          data: {
            createDiscussion: {
              discussion: { id: 'D_1', url: 'https://github.com/x/y/discussions/1', body: bodyArg.slice('body='.length) },
            },
          },
        }),
      };
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };

  const result = publishExplainDiscussion(
    { issue: 300, category: 'Explain', title: 'issue #300 教材', file: 'explains/2026-07-08-issue300-x.md' },
    { spawnSync, readFileSync: fakeReadFileSync(materialBody) },
  );

  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://github.com/x/y/discussions/1');

  const mutationCall = calls.find((args) => args.join(' ').includes('createDiscussion'));
  const bodyArg = mutationCall.find((a) => a.startsWith('body='));
  assert.equal(bodyArg, `body=${materialBody}`, 'body 引数は材料内容そのもの');
  assert.ok(!mutationCall.some((a) => a.startsWith('body=@')), 'body 引数は @ literal であってはならない');
  assert.ok(mutationCall.includes('-f'), 'raw-field(-f) で渡す（@ の file-read magic を持つ -F は使わない）');
  assert.ok(!mutationCall.includes('-F'), '-F（file-read magic あり）は使わない');
});

test('publishExplainDiscussion: 空の殻（createDiscussion 応答の body が @explains 始まり）は ok:false', () => {
  const materialBody = '# Background\n\n教材の中身。'.repeat(50);
  const spawnSync = (cmd, args) => {
    if (args.join(' ').includes('discussionCategories')) {
      return {
        status: 0,
        stdout: JSON.stringify({
          data: { repository: { id: 'REPO_ID_1', discussionCategories: { nodes: [{ id: 'CAT_EXPLAIN', name: 'Explain' }] } } },
        }),
      };
    }
    return {
      status: 0,
      stdout: JSON.stringify({
        data: { createDiscussion: { discussion: { id: 'D_1', url: 'u', body: '@explains/2026-07-08-issue300-x.md' } } },
      }),
    };
  };
  const result = publishExplainDiscussion(
    { issue: 300, category: 'Explain', title: 't', file: 'f.md' },
    { spawnSync, readFileSync: fakeReadFileSync(materialBody) },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /self-check failed/);
  assert.match(result.reason, /@explains/);
});

test('publishExplainDiscussion: category が見つからない場合は ok:false（gh へ createDiscussion を投げない）', () => {
  let createCalled = false;
  const spawnSync = (cmd, args) => {
    if (args.join(' ').includes('createDiscussion')) createCalled = true;
    return {
      status: 0,
      stdout: JSON.stringify({
        data: { repository: { id: 'REPO_ID_1', discussionCategories: { nodes: [{ id: 'CAT_GENERAL', name: 'General' }] } } },
      }),
    };
  };
  const result = publishExplainDiscussion(
    { issue: 300, category: 'Explain', title: 't', file: 'f.md' },
    { spawnSync, readFileSync: fakeReadFileSync('# 材料') },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /category "Explain" not found/);
  assert.equal(createCalled, false);
});

test('publishExplainDiscussion: repository/category query が失敗したら ok:false（reason 保持）', () => {
  const spawnSync = () => ({ status: 1, stderr: 'boom' });
  const result = publishExplainDiscussion(
    { issue: 300, category: 'Explain', title: 't', file: 'f.md' },
    { spawnSync, readFileSync: fakeReadFileSync('# 材料') },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /repository\/category query failed/);
  assert.match(result.reason, /boom/);
});

// --- addExplainComment（create と同じ body 解決を共有） ---

test('addExplainComment: body=材料内容を -f で graphql に渡し self-check する', () => {
  const materialBody = '# 追補\n\n教材の中身。'.repeat(30);
  const calls = [];
  const spawnSync = (cmd, args) => {
    calls.push(args);
    const bodyArg = args.find((a) => a.startsWith('body='));
    return {
      status: 0,
      stdout: JSON.stringify({
        data: { addDiscussionComment: { comment: { id: 'C_1', url: 'https://github.com/x/y/discussions/1#comment', body: bodyArg.slice('body='.length) } } },
      }),
    };
  };
  const result = addExplainComment(
    { discussionId: 'D_1', file: 'explains/2026-07-08-issue300-y.md' },
    { spawnSync, readFileSync: fakeReadFileSync(materialBody) },
  );
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://github.com/x/y/discussions/1#comment');
  const bodyArg = calls[0].find((a) => a.startsWith('body='));
  assert.equal(bodyArg, `body=${materialBody}`);
  assert.ok(!calls[0].some((a) => a.startsWith('body=@')));
  assert.ok(calls[0].some((a) => a.startsWith('discussionId=D_1')));
});

test('addExplainComment: gh 呼び出し失敗は ok:false（reason 保持）', () => {
  const spawnSync = () => ({ status: 1, stderr: 'gh boom' });
  const result = addExplainComment(
    { discussionId: 'D_1', file: 'f.md' },
    { spawnSync, readFileSync: fakeReadFileSync('# 材料') },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /addDiscussionComment failed/);
  assert.match(result.reason, /gh boom/);
});
