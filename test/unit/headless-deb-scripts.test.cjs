/* globals describe, it, expect */

/**
 * deb 的 maintainer 脚本语义 —— 这是「升级」能否真正生效的唯一闸门。
 *
 * 背景（真踩过的坑）：`prerm` 在**升级时也会执行**（`prerm upgrade`）。若在那里 `systemctl stop`
 * + `disable`，`apt upgrade` / `unattended-upgrade` 之后服务既没重启、也丢了开机自启，
 * 表现是「包升级了，但进程还在跑旧代码 / 干脆不起来了」。所以：
 *   - 停服务只在 remove / deconfigure；
 *   - disable 只在 purge；
 *   - 升级后由 postinst 的 `try-restart` 让新版本真正跑起来（服务没在跑就什么都不做）。
 */

const { DEB_POSTINST, DEB_PRERM, DEB_POSTRM, buildControlText } = require('../../scripts/pack-headless.cjs');

describe('headless deb: 升级/卸载的服务语义', () => {
  it('prerm 只在 remove/deconfigure 时停服务，且从不 disable', () => {
    expect(DEB_PRERM).toMatch(/remove\|deconfigure\)/);
    expect(DEB_PRERM).toContain('systemctl stop dieyun-headless.service');
    expect(DEB_PRERM).not.toMatch(/systemctl disable/);
    // upgrade 分支不做事：case 里没有 upgrade 分支就等于「升级时不动服务」
    expect(DEB_PRERM).not.toMatch(/^\s*upgrade\)/m);
  });

  it('postinst 用 try-restart（升级后新版本立刻生效，首装不擅自拉起）', () => {
    expect(DEB_POSTINST).toContain('systemctl try-restart dieyun-headless.service');
    expect(DEB_POSTINST).not.toMatch(/systemctl (start|enable)\s/);
  });

  it('postrm 只在 purge 时 disable，且不删用户数据目录', () => {
    expect(DEB_POSTRM).toMatch(/purge\)/);
    expect(DEB_POSTRM).toMatch(/systemctl disable/);
    expect(DEB_POSTRM).not.toMatch(/rm -rf \/var\/lib\/dieyun-agent/);
    expect(DEB_POSTRM).not.toMatch(/rm -rf \/etc\/dieyun/);
  });

  it('postinst 绝不覆盖已存在的 secret.key / headless.env（覆盖等于作废凭据）', () => {
    expect(DEB_POSTINST).toMatch(/if \[ ! -f \/etc\/dieyun\/secret\.key \]/);
    expect(DEB_POSTINST).toMatch(/if \[ ! -f \/etc\/dieyun\/headless\.env \]/);
  });

  it('/etc/dieyun 的组必须是 dieyun（否则服务用户读不到 env 与 secret.key）', () => {
    // 真机踩过：目录建成 root:root 0750，systemd 以 root 读 EnvironmentFile 所以服务照常起，
    // 但 dieyun 用户连 read(2) 都到不了 → 手工 CLI 报「未配置 API Key」、运行时读不到密钥。
    expect(DEB_POSTINST).toMatch(/install -d -o root -g dieyun -m 0750 \/etc\/dieyun/);
    expect(DEB_POSTINST).toMatch(/chgrp dieyun \/etc\/dieyun/);
    expect(DEB_POSTINST).not.toMatch(/install -d -m 0750 \/etc\/dieyun\nchgrp root/);
  });

  it('control 的 Depends 取 manifest 的 glibc 地板，不是手写常量', () => {
    const text = buildControlText({ version: '9.9.9', installedKb: 1234, libcMin: '2.28' });
    expect(text).toContain('Package: dieyun-headless');
    expect(text).toContain('Version: 9.9.9');
    expect(text).toContain('Architecture: amd64');
    expect(text).toContain('Depends: libc6 (>= 2.28)');
    expect(text).toContain('Installed-Size: 1234');
    // 没有 glibc 地板时退化成裸 libc6，不写死一个假版本
    expect(buildControlText({ version: '1', installedKb: 1, libcMin: '' })).toContain('Depends: libc6\n');
  });
});
