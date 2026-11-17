'use strict';

/**
 * peer 落盘层（身份 / 信任清单 / 会话绑定 / 手工对端 / 开关）与「项目身份 key」的断言。
 *
 * 这两块是内网互通的地基：身份错了就等于换了台机器，key 错了就会把两个不相干的项目
 * 当成同一个项目协同（比不协同更坏）。网络层另见 `scripts/test-peer-mesh.cjs`。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPeerStore } = require('../src/peer/store');
const { readGitRemoteUrl, workspaceKeyFor, workspaceInfoFor, normalizeRemoteUrl } = require('../src/peer/workspace-key');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dieyun-peer-${prefix}-`));
}

function main() {
  const root = mkTmp('store');
  try {
    // —— 身份 ——
    const store = createPeerStore(root);
    const id = store.identity();
    assert.match(id.peerId, /^peer_[0-9a-f]{18}$/, `peerId 形状不对: ${id.peerId}`);
    assert.ok(id.name && id.name.length > 0, '名称不能为空');
    assert.ok(fs.existsSync(store.files.identity), 'identity.json 应落盘');

    const store2 = createPeerStore(root);
    assert.strictEqual(store2.identity().peerId, id.peerId, '重启后 peerId 必须不变');

    store.setName('  前端   机器 ');
    assert.strictEqual(store.identity().name, '前端 机器', '名称应折叠空白');
    assert.strictEqual(createPeerStore(root).identity().name, '前端 机器', '名称应持久化');

    // —— 工作身份（自称的角色）：持久化 / 折叠空白 / 有长度上限 / 可清空 ——
    assert.strictEqual(store.identity().role, '', '默认没有身份');
    store.setRole('  发票   模块 ');
    assert.strictEqual(store.identity().role, '发票 模块', '身份应折叠空白');
    assert.strictEqual(createPeerStore(root).identity().role, '发票 模块', '身份应持久化');
    store.setRole('x'.repeat(80));
    assert.strictEqual(store.identity().role.length, 32, '身份长度上限 32');
    store.setRole('   ');
    assert.strictEqual(store.identity().role, '', '空白 = 清掉身份');

    // —— 信任清单（取代配对码）：allow / deny / 撤销，按 peerId 记住 ——
    assert.deepStrictEqual(store.trustEntries(), [], '初始没有任何信任记录');
    assert.strictEqual(store.trustStatus('peer_cccccccccccccccccc'), '', '没记录 → 空状态（= 需要确认）');
    assert.strictEqual(store.isTrusted('peer_cccccccccccccccccc'), false);

    store.setTrust('peer_cccccccccccccccccc', 'allow', '同事A');
    assert.strictEqual(store.trustStatus('peer_cccccccccccccccccc'), 'allow');
    assert.strictEqual(store.isTrusted('peer_cccccccccccccccccc'), true);
    assert.ok(fs.existsSync(store.files.trust), 'trusted-peers.json 应落盘');
    assert.strictEqual(
      createPeerStore(root).trustStatus('peer_cccccccccccccccccc'),
      'allow',
      '允许决定必须持久化（重启后不用再确认）'
    );
    const entries = createPeerStore(root).trustEntries();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].name, '同事A', '名字要一起记住，面板上才看得懂');
    assert.ok(entries[0].at > 0, '要记时间（按最近决定排序）');

    store.setTrust('peer_dddddddddddddddddd', 'deny');
    assert.strictEqual(store.trustStatus('peer_dddddddddddddddddd'), 'deny');
    assert.strictEqual(store.isTrusted('peer_dddddddddddddddddd'), false);

    // 撤销：回到「不认识」，下次来信要重新确认
    store.setTrust('peer_cccccccccccccccccc', 'clear');
    assert.strictEqual(store.trustStatus('peer_cccccccccccccccccc'), '', '撤销后应回到未知');
    assert.deepStrictEqual(
      store.trustEntries().map((e) => e.peerId),
      ['peer_dddddddddddddddddd'],
      '撤销只删这一条'
    );

    // 非法输入不进文件（避免面板上出现点不动的幽灵条目）
    store.setTrust('   ', 'allow');
    store.setTrust('peer_eeeeeeeeeeeeeeeeee', /** @type {any} */ ('whatever'));
    assert.strictEqual(store.trustStatus('peer_eeeeeeeeeeeeeeeeee'), '', '未知状态不应写入');

    // —— 会话绑定 ——
    assert.deepStrictEqual(store.links(), {}, '初始没有绑定');
    store.linkSession('sess_1', 'peer_aaaaaaaaaaaaaaaaaa');
    assert.strictEqual(store.peerForSession('sess_1'), 'peer_aaaaaaaaaaaaaaaaaa');
    assert.deepStrictEqual(store.sessionsForPeer('peer_aaaaaaaaaaaaaaaaaa'), ['sess_1']);
    store.linkSession('sess_1', 'peer_bbbbbbbbbbbbbbbbbb');
    assert.strictEqual(store.peerForSession('sess_1'), 'peer_bbbbbbbbbbbbbbbbbb', '同一会话改绑应覆盖');
    assert.deepStrictEqual(createPeerStore(root).links(), { sess_1: 'peer_bbbbbbbbbbbbbbbbbb' }, '绑定应持久化');
    store.unlinkSession('sess_1');
    assert.strictEqual(store.peerForSession('sess_1'), '', '解绑后应为空');
    assert.strictEqual(store.peerForSession(''), '', '空会话 id 不应崩');

    // —— 「通道自己的对话」与「只是被接管的本机任务会话」分列 ——
    // 历史列表只把前者归到「Bot 对话」：按 links 归堆会把正在干活的
    // 项目会话从项目文件夹里搬走（2026-11-12 的现场事故）。
    assert.deepStrictEqual(store.chatSessions(), [], '初始没有通道对话');
    store.linkSession('sess_task', 'peer_aaaaaaaaaaaaaaaaaa');
    assert.strictEqual(store.isChatSession('sess_task'), false, '只建绑定不等于通道对话');
    store.markChatSession('sess_chat');
    assert.strictEqual(store.isChatSession('sess_chat'), true);
    assert.ok(fs.existsSync(store.files.chats), 'channel-sessions.json 应落盘');
    assert.deepStrictEqual(createPeerStore(root).chatSessions(), ['sess_chat'], '通道对话应持久化');
    store.markChatSession('sess_chat');
    assert.deepStrictEqual(store.chatSessions(), ['sess_chat'], '重复标记不重复');
    store.markChatSession('   ');
    assert.deepStrictEqual(store.chatSessions(), ['sess_chat'], '空 id 不写入');
    store.linkSession('sess_chat', 'peer_aaaaaaaaaaaaaaaaaa');
    store.unlinkSession('sess_chat');
    assert.strictEqual(store.isChatSession('sess_chat'), false, '解绑后不再是通道对话');
    assert.deepStrictEqual(createPeerStore(root).chatSessions(), [], '解绑也要落盘');

    // —— 手工对端（端口必须合法，坏条目静默丢弃）——
    const cleaned = store.setStaticPeers([
      { host: ' 192.168.31.9 ', port: '17350', name: '同事A' },
      { host: '', port: 17351 },
      { host: '10.0.0.2', port: 0 },
      { host: '10.0.0.3', port: 70000 }
    ]);
    assert.deepStrictEqual(cleaned, [{ host: '192.168.31.9', port: 17350, name: '同事A' }]);
    assert.deepStrictEqual(createPeerStore(root).staticPeers(), cleaned, '手工对端应持久化');

    // —— 开关 ——
    assert.deepStrictEqual(
      store.settings(),
      { enabled: true, autoTurn: true, autoTrust: false },
      '默认开互通 + 默认自动跑一轮；但授权默认**要人确认**（autoTrust=false，无人值守入口才落成 true）'
    );
    assert.deepStrictEqual(store.setSettings({ autoTurn: false }), {
      enabled: true,
      autoTurn: false,
      autoTrust: false
    });
    assert.deepStrictEqual(
      createPeerStore(root).settings(),
      { enabled: true, autoTurn: false, autoTrust: false },
      '开关应持久化'
    );
    assert.deepStrictEqual(
      createPeerStore(root).setSettings({ autoTurn: /** @type {any} */ ('yes') }),
      { enabled: true, autoTurn: false, autoTrust: false },
      '非 true 一律当关（不做真值猜测）'
    );
    assert.deepStrictEqual(
      createPeerStore(root).setSettings({}),
      { enabled: true, autoTurn: false, autoTrust: false },
      '缺省沿用落盘值'
    );
    // 无人值守入口只**补缺失**的字段：人已经写过的值一律不覆盖。
    // 用一份全新的目录 —— 上面任何一次 setSettings 都会把 autoTrust 写进去，混在一起就测不出「缺失」语义。
    const freshRoot = mkTmp('store-fresh');
    try {
      assert.deepStrictEqual(
        createPeerStore(freshRoot).ensureSettings({ autoTrust: true }),
        { enabled: true, autoTurn: true, autoTrust: true },
        'ensureSettings 在字段缺失时落成给定值（headless 首次启动的形状）'
      );
      assert.deepStrictEqual(
        createPeerStore(freshRoot).ensureSettings({ autoTrust: false }),
        { enabled: true, autoTurn: true, autoTrust: true },
        'ensureSettings 不覆盖已存在的值（人改成 true 后重启不被改回去）'
      );
      assert.deepStrictEqual(
        createPeerStore(freshRoot).setSettings({ autoTrust: false }),
        { enabled: true, autoTurn: true, autoTrust: false },
        'autoTrust 可显式关回人工确认'
      );
    } finally {
      fs.rmSync(freshRoot, { recursive: true, force: true });
    }

    // —— 房间（一次任务一个）：建 / 关 / 有界保留 ——
    assert.deepStrictEqual(store.rooms(), [], '初始没有房间');
    assert.strictEqual(store.roomById('r-nope'), null, '查不到的房间返回 null 而不是抛');

    const roomA = store.createRoom({
      roomId: 'r-test-a',
      title: '  修发票   模块 ',
      projectKey: 'abc123',
      members: ['peer_aaaaaaaaaaaaaaaaaa', 'peer_bbbbbbbbbbbbbbbbbb', 'peer_aaaaaaaaaaaaaaaaaa'],
      createdAt: 1000
    });
    assert.strictEqual(roomA.title, '修发票 模块', '标题折叠空白');
    assert.deepStrictEqual(roomA.members, ['peer_aaaaaaaaaaaaaaaaaa', 'peer_bbbbbbbbbbbbbbbbbb'], '成员去重');
    assert.strictEqual(roomA.status, 'open');
    assert.strictEqual(roomA.closedAt, 0);
    assert.ok(fs.existsSync(store.files.rooms), 'rooms.json 应落盘');

    const reread = createPeerStore(root).rooms();
    assert.strictEqual(reread.length, 1, '房间应持久化');
    assert.strictEqual(reread[0].members.length, 2);
    assert.strictEqual(reread[0].projectKey, 'abc123');

    // 关房间：只改状态与时间，不删记录（历史仍可回看），且幂等
    const closed = store.closeRoom('r-test-a');
    assert.strictEqual(closed.status, 'closed');
    const closedAt = closed.closedAt;
    assert.ok(closedAt > 0, '要记结束时间');
    assert.strictEqual(store.closeRoom('r-test-a').closedAt, closedAt, '重复关不该刷新时间');
    assert.strictEqual(store.closeRoom('r-nope'), null, '关不存在的房间返回 null');
    assert.strictEqual(createPeerStore(root).roomById('r-test-a').status, 'closed', '结束状态应持久化');

    // 有界保留：只丢最老的**已关闭**房间，打开中的永不丢
    store.createRoom({ roomId: 'r-test-b', members: ['peer_aaaaaaaaaaaaaaaaaa'], createdAt: 2000 });
    store.createRoom({ roomId: 'r-test-c', members: ['peer_aaaaaaaaaaaaaaaaaa'], createdAt: 3000 });
    store.closeRoom('r-test-c');
    const pruned = store.pruneRooms(2).map((r) => r.roomId);
    assert.deepStrictEqual(pruned, ['r-test-c', 'r-test-b'], '应丢掉最老的已关闭房间，保留打开中的');
    assert.deepStrictEqual(
      createPeerStore(root).rooms().map((r) => r.roomId),
      ['r-test-c', 'r-test-b'],
      '裁剪结果应落盘'
    );
    assert.strictEqual(store.pruneRooms(0).length, 2, 'keep<=0 视为不裁剪');

    // 脏条目跳过（不修补）：缺 roomId / 状态非法的直接不进清单
    fs.writeFileSync(
      store.files.rooms,
      JSON.stringify({
        rooms: [
          { roomId: 'r-ok', title: '好房间', status: 'open', members: ['peer_aaaaaaaaaaaaaaaaaa'] },
          { roomId: '', title: '没 id', status: 'open', members: [] },
          { roomId: 'r-bad', title: '坏状态', status: 'whatever', members: [] }
        ]
      }),
      'utf8'
    );
    assert.deepStrictEqual(createPeerStore(root).rooms().map((r) => r.roomId), ['r-ok'], '坏条目应被跳过');

    // —— 项目身份 key ——
    assert.strictEqual(workspaceKeyFor(''), '', '空路径应返回空 key');
    const repoDir = mkTmp('repo');
    const otherDir = mkTmp('repo-other');
    try {
      // 没有 git：退回路径哈希，两个不同目录必须不同 key
      const pathKey = workspaceKeyFor(repoDir);
      assert.strictEqual(pathKey.length, 12);
      assert.notStrictEqual(pathKey, workspaceKeyFor(otherDir));

      // 有 git remote：key 由 remote 决定 —— 同一 remote 的两个克隆必须同 key
      const gitDir = path.join(repoDir, '.git');
      fs.mkdirSync(gitDir, { recursive: true });
      fs.writeFileSync(
        path.join(gitDir, 'config'),
        ['[core]', '\trepositoryformatversion = 0', '[remote "origin"]', '\turl = git@github.com:dieyun/agent.git', '\tfetch = +refs/heads/*:refs/remotes/origin/*', ''].join('\n'),
        'utf8'
      );
      assert.strictEqual(readGitRemoteUrl(repoDir), 'github.com/dieyun/agent', 'SSH remote 应归一为 host/path');
      assert.strictEqual(normalizeRemoteUrl('https://GitHub.com/dieyun/agent.git/'), 'github.com/dieyun/agent');

      const cloneDir = mkTmp('clone');
      try {
        fs.mkdirSync(path.join(cloneDir, '.git'), { recursive: true });
        fs.writeFileSync(
          path.join(cloneDir, '.git', 'config'),
          ['[remote "origin"]', '\turl = https://github.com/dieyun/agent', ''].join('\n'),
          'utf8'
        );
        assert.strictEqual(workspaceKeyFor(cloneDir), workspaceKeyFor(repoDir), '同一 remote 的两个克隆应同 key');
        assert.strictEqual(workspaceInfoFor(cloneDir).name, path.basename(cloneDir), 'name 用目录名展示');
      } finally {
        fs.rmSync(cloneDir, { recursive: true, force: true });
      }

      // worktree：`.git` 是文件（gitdir: ...），真正的 remote 在主仓库 git 目录里，
      // worktree 的 gitdir 通过 commondir 指过去 —— 必须顺着这一跳才能判成同一项目。
      const wtDir = mkTmp('wt');
      try {
        const wtGitDir = path.join(gitDir, 'worktrees', 'wt');
        fs.mkdirSync(wtGitDir, { recursive: true });
        fs.writeFileSync(path.join(wtGitDir, 'commondir'), '../..\n', 'utf8');
        fs.writeFileSync(path.join(wtDir, '.git'), `gitdir: ${wtGitDir}\n`, 'utf8');
        assert.strictEqual(workspaceKeyFor(wtDir), workspaceKeyFor(repoDir), 'worktree 应与其主仓库同 key（同 remote）');
      } finally {
        fs.rmSync(wtDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('test-peer-store.cjs ok');
}

main();
