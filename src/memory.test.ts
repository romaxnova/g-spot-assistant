import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containerMemory, memoryReport } from './memory.js';

const files = (map: Record<string, string>) => (path: string) => {
  const content = map[path];
  if (content === undefined) throw new Error(`ENOENT ${path}`);
  return content;
};

test('the container figures come from cgroup v2, else v1; outside a container there are none', () => {
  assert.deepEqual(
    containerMemory(files({ '/proc/self/cgroup': '0::/\n', '/sys/fs/cgroup/memory.current': '629145600\n', '/sys/fs/cgroup/memory.stat': 'anon 209715200\nfile 398458880\nkernel 1000\n' })),
    { containerMb: 600, containerAnonMb: 200, containerFileMb: 380 },
  );
  assert.deepEqual(
    containerMemory(
      files({
        '/proc/self/cgroup': '12:cpuset:/\n4:memory:/docker/abc\n1:name=systemd:/\n',
        '/sys/fs/cgroup/memory/docker/abc/memory.usage_in_bytes': '104857600',
        '/sys/fs/cgroup/memory/docker/abc/memory.stat': 'cache 52428800\nrss 41943040\nmapped_file 0\n',
      }),
    ),
    { containerMb: 100, containerAnonMb: 40, containerFileMb: 50 },
  );
  // Docker on a host mounting both versions: the memory controller is v1's, and the container sees its own group at the mount's root.
  assert.deepEqual(
    containerMemory(
      files({
        '/proc/self/cgroup': '4:memory:/docker/abc\n1:name=systemd:/docker/abc\n0::/docker/abc\n',
        '/sys/fs/cgroup/memory/memory.usage_in_bytes': '209715200',
        '/sys/fs/cgroup/memory/memory.stat': 'cache 104857600\nrss 94371840\n',
      }),
    ),
    { containerMb: 200, containerAnonMb: 90, containerFileMb: 100 },
  );
  // A v2 container whose group path is not mounted inside it.
  assert.deepEqual(
    containerMemory(files({ '/proc/self/cgroup': '0::/system.slice/x.scope\n', '/sys/fs/cgroup/memory.current': '104857600', '/sys/fs/cgroup/memory.stat': 'anon 52428800\nfile 41943040\n' })),
    { containerMb: 100, containerAnonMb: 50, containerFileMb: 40 },
  );
  assert.equal(containerMemory(files({ '/proc/self/cgroup': '1:name=systemd:/\n' })), undefined);
  assert.equal(containerMemory(files({})), undefined);
});

test('the report gives the process figures in MB', () => {
  const m = memoryReport();
  for (const v of [m.rssMb, m.heapUsedMb, m.heapTotalMb, m.externalMb]) assert.ok(Number.isFinite(v) && v >= 0);
  assert.ok(m.rssMb >= m.heapUsedMb);
});
