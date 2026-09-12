import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { GitHub } from "./github";
import { abortable, command } from "./process";

export async function prepareWorkspace(github: GitHub, tempRoot: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(tempRoot, "task-"));
  try {
    const repo = await abortable(github.metadata(), signal);
    const sha = await abortable(github.head(repo.default_branch), signal);
    const archive = path.join(directory, "repository.tar.gz");
    await Bun.write(archive, await github.archive(sha, signal, !repo.private));
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace);
    await command(["python3", "-c", `import tarfile,pathlib,sys
target=pathlib.Path(sys.argv[2]).resolve(); total=0
with tarfile.open(sys.argv[1]) as archive:
 for member in archive:
  if not member.isfile(): continue
  parts=pathlib.PurePosixPath(member.name).parts[1:]
  if not parts or '..' in parts or any(p in ('.git','.env','node_modules','.runtime') for p in parts): continue
  total+=member.size
  if total>500000000 or member.size>20000000: raise RuntimeError('Source extraction exceeds limit')
  dest=target.joinpath(*parts)
  if not dest.is_relative_to(target): raise RuntimeError('Unsafe archive path')
  dest.parent.mkdir(parents=True,exist_ok=True)
  data=archive.extractfile(member)
  if data: dest.write_bytes(data.read())
`, archive, workspace], { timeoutMs: 120_000, signal });
    await rm(archive);
    return { directory, workspace, sha, branch: repo.default_branch, private: repo.private, dispose: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
