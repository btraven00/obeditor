// Pyodide web worker: loads omnibenchmark and converts YAML → Snakefile preview

importScripts("https://cdn.jsdelivr.net/pyodide/v0.27.3/full/pyodide.js");

let pyodide = null;

// Python code stored as a regular (non-template) string to avoid escaping hell.
// Each \n is a real JS escape → newline.  Each \\ is a literal backslash.
// Python sees exactly what's written here.
const PREVIEW_PY = [
  "import io, warnings, itertools, re, hashlib",
  "from pathlib import PurePosixPath",
  "",
  "def _repo_name(url):",
  "    # Match production: Path(parse_repo_url(url)).name, strip .git suffix",
  "    # e.g. https://github.com/user/pbmc3k.git -> pbmc3k",
  "    name = PurePosixPath(url.rstrip('/')).name",
  "    return name[:-4] if name.endswith('.git') else name",
  "warnings.filterwarnings('ignore')",
  "",
  "def _expand_param(param):",
  "    if param.params:",
  "        keys = list(param.params.keys())",
  "        vals = [v if isinstance(v, list) else [v] for v in param.params.values()]",
  "        return [dict(zip(keys, c)) for c in itertools.product(*vals)]",
  "    elif param.values:",
  "        return [{'_cli': ' '.join(param.values)}]",
  "    return [{}]",
  "",
  "def _all_combos(module):",
  "    if not module.parameters:",
  "        return [{}]",
  "    result = [{}]",
  "    for param in module.parameters:",
  "        expanded = _expand_param(param)",
  "        result = [{**a, **b} for a in result for b in expanded]",
  "    return result or [{}]",
  "",
  "def _phash(combo):",
  "    s = '_'.join(f'{k}={v}' for k, v in sorted(combo.items()))",
  "    return hashlib.md5(s.encode()).hexdigest()[:8]",
  "",
  "def _rulename(*parts):",
  "    name = '__'.join(str(p) for p in parts)",
  "    name = re.sub(r'[^a-zA-Z0-9_]', '_', name)",
  "    return ('r_' + name) if name and not name[0].isalpha() else name",
  "",
  "def _ikey(entry):",
  "    return re.sub(r'[^a-zA-Z0-9_]', '_', entry)",
  "",
  "def _env_dir(bench, module):",
  "    eid = module.software_environment",
  "    if not eid: return ''",
  "    env = next((e for e in bench.software_environments if e.id == eid), None)",
  "    if not env: return ''",
  "    b = bench.software_backend.value",
  "    if b == 'conda' and env.conda:",
  "        return f'    conda: \"{env.conda}\"\\n'",
  "    if b == 'apptainer' and env.apptainer:",
  "        return f'    container: \"{env.apptainer}\"\\n'",
  "    if b == 'envmodules' and env.envmodule:",
  "        return f'    envmodules: \"{env.envmodule}\"\\n'",
  "    return ''",
  "",
  "def _res_dir(r):",
  "    if not r: return ''",
  "    lines = ['    resources:']",
  "    lines.append(f'        cores={r.cores or 2},')",
  "    if r.mem_mb:  lines.append(f'        mem_mb={r.mem_mb},')",
  "    if r.disk_mb: lines.append(f'        disk_mb={r.disk_mb},')",
  "    if r.runtime: lines.append(f'        runtime={r.runtime},')",
  "    if r.gpu:     lines.append(f'        nvidia_gpu={r.gpu},')",
  "    return '\\n'.join(lines) + '\\n'",
  "",
  "def _opath(mid, ph, outf):",
  "    path = outf.path.replace('{dataset}', mid)",
  "    return f'data/{mid}/.{ph}/{path}'",
  "",
  "def _generate(bench):",
  "    out = io.StringIO()",
  "    backend = bench.software_backend.value",
  "    out.write(f'# OmniBenchmark: {bench.id} v{bench.version}\\n')",
  "    out.write(f'# Benchmarker: {bench.benchmarker}\\n')",
  "    out.write(f'# Backend: {backend}\\n')",
  "    out.write('# Preview — module paths are placeholders, resolved at runtime.\\n\\n')",
  "",
  "    # index output_id -> [concrete paths]",
  "    oid_paths = {}",
  "    for stage in bench.stages:",
  "        for module in stage.modules:",
  "            for combo in _all_combos(module):",
  "                ph = _phash(combo)",
  "                for outf in (stage.outputs or []):",
  "                    oid_paths.setdefault(outf.id, []).append(_opath(module.id, ph, outf))",
  "",
  "    # rule all",
  "    all_out = [p for paths in oid_paths.values() for p in paths]",
  "    out.write('rule all:\\n    input:\\n')",
  "    for p in all_out:",
  "        out.write(f'        \"{p}\",\\n')",
  "    out.write('\\n\\n')",
  "",
  "    for stage in bench.stages:",
  "        out.write(f'# {\"=\" * 60}\\n# Stage: {stage.id}\\n# {\"=\" * 60}\\n\\n')",
  "        # resolve inputs for this stage",
  "        sinputs = {}",
  "        if stage.inputs:",
  "            for ic in stage.inputs:",
  "                for entry in ic.entries:",
  "                    sinputs[entry] = oid_paths.get(entry, [f'# unresolved:{entry}'])",
  "        for module in stage.modules:",
  "            res = module.resources or stage.resources",
  "            rname = _repo_name(module.repository.url)",
  "            commit = module.repository.commit[:7]",
  "            for combo in _all_combos(module):",
  "                ph = _phash(combo)",
  "                has_combo = combo and list(combo.keys()) != ['_cli']",
  "                rname = _rulename(stage.id, module.id, ph) if has_combo else _rulename(stage.id, module.id)",
  "                out.write(f'rule {rname}:\\n')",
  "                # inputs",
  "                if sinputs:",
  "                    out.write('    input:\\n')",
  "                    for entry, paths in sinputs.items():",
  "                        k = _ikey(entry)",
  "                        if len(paths) == 1:",
  "                            out.write(f'        {k}=\"{paths[0]}\",\\n')",
  "                        else:",
  "                            out.write(f'        {k}=[\\n')",
  "                            for p in paths:",
  "                                out.write(f'            \"{p}\",\\n')",
  "                            out.write('        ],\\n')",
  "                # outputs",
  "                out.write('    output:\\n')",
  "                for outf in (stage.outputs or []):",
  "                    out.write(f'        \"{_opath(module.id, ph, outf)}\",\\n')",
  "                # log",
  "                out.write(f'    log:\\n        \"logs/{stage.id}/{module.id}/{ph}.log\",\\n')",
  "                # env",
  "                ed = _env_dir(bench, module)",
  "                if ed: out.write(ed)",
  "                # resources",
  "                rd = _res_dir(res)",
  "                if rd: out.write(rd)",
  "                # params",
  "                out.write('    params:\\n')",
  "                out.write(f'        module_dir=\".modules/{rname}/{commit}/\",\\n')",
  "                out.write('        entrypoint=\"run.py\",  # resolved from repo\\n')",
  "                if combo:",
  "                    parts = [f'--{k} {v}' for k, v in combo.items() if k != '_cli']",
  "                    if '_cli' in combo: parts.append(combo['_cli'])",
  "                    if parts:",
  "                        out.write(f'        cli_args=\"{\" \".join(parts)}\",\\n')",
  "                # shell — single-line commands for preview clarity",
  "                out.write('    shell:\\n')",
  "                out.write('        \"\"\"\\n')",
  "                out.write('        mkdir -p $(dirname {output[0]}) $(dirname {log})\\n')",
  "                out.write('        exec > >(tee {log}) 2>&1\\n')",
  "                out.write('        cd {params.module_dir}\\n')",
  "                # build the command on one line for preview",
  "                input_args = ' '.join(",
  "                    f'--{e.replace(\".\", \"_\")} {{input.{_ikey(e)}}}'",
  "                    for e in sinputs",
  "                )",
  "                cli_arg = '{params.cli_args}' if combo else ''",
  "                cmd = (f'python3 {{params.entrypoint}}'",
  "                       f' --output_dir $(dirname {{output[0]}})'",
  "                       f' --name {module.id}'",
  "                       + (f' {input_args}' if input_args else '')",
  "                       + (f' {cli_arg}' if cli_arg else ''))",
  "                out.write(f'        {cmd}\\n')",
  "                out.write('        \"\"\"\\n\\n')",
  "",
  "    # metric collectors",
  "    if bench.metric_collectors:",
  "        out.write(f'# {\"=\" * 60}\\n# Metric Collectors\\n# {\"=\" * 60}\\n\\n')",
  "        for mc in bench.metric_collectors:",
  "            rname = _rulename('collect', mc.id)",
  "            out.write(f'rule {rname}:\\n    input:\\n')",
  "            for inp in mc.inputs:",
  "                iid = inp if isinstance(inp, str) else inp.id",
  "                k = _ikey(iid)",
  "                paths = oid_paths.get(iid, [f'# unresolved:{iid}'])",
  "                out.write(f'        {k}=[\\n')",
  "                for p in paths:",
  "                    out.write(f'            \"{p}\",\\n')",
  "                out.write('        ],\\n')",
  "            out.write('    output:\\n')",
  "            for outf in mc.outputs:",
  "                out.write(f'        \"data/metrics/{mc.id}/{outf.path}\",\\n')",
  "            ed = _env_dir(bench, mc)",
  "            if ed: out.write(ed)",
  "            out.write('\\n')",
  "",
  "    return out.getvalue()",
  "",
  "def _generate_runner(bench):",
  "    out = io.StringIO()",
  "    backend = bench.software_backend.value",
  "    out.write('#!/usr/bin/env bash\\n')",
  "    out.write(f'# OmniBenchmark run script: {bench.id} v{bench.version}\\n')",
  "    out.write(f'# Benchmarker: {bench.benchmarker}\\n')",
  "    out.write('# Generated by OBEditor\\n')",
  "    out.write('#\\n')",
  "    out.write('# Usage: bash run.sh [CORES]\\n')",
  "    out.write('# Expects: Snakefile in cwd, git + snakemake in PATH\\n')",
  "    out.write('set -euo pipefail\\n\\n')",
  "    out.write('CORES=\"${1:-4}\"\\n')",
  "    out.write('MODULES_DIR=\".modules\"\\n\\n')",
  "    # clone helper",
  "    out.write('# ── Module resolution ──────────────────────────────────────────────────\\n')",
  "    out.write('mkdir -p \"$MODULES_DIR\"\\n\\n')",
  "    out.write('clone_module() {\\n')",
  "    out.write('    local name=\"$1\" url=\"$2\" repo=\"$3\" commit=\"$4\"\\n')",
  "    out.write('    local dest=\"$MODULES_DIR/$repo/$commit\"\\n')",
  "    out.write('    if [ -d \"$dest/.git\" ]; then\\n')",
  "    out.write('        echo \"  already resolved: $name\"\\n')",
  "    out.write('        return 0\\n')",
  "    out.write('    fi\\n')",
  "    out.write('    echo \"  cloning $name -> $dest\"\\n')",
  "    out.write('    mkdir -p \"$(dirname \"$dest\")\"\\n')",
  "    out.write('    git clone --filter=blob:none --no-checkout \"$url\" \"$dest\"\\n')",
  "    out.write('    git -C \"$dest\" checkout \"$commit\"\\n')",
  "    out.write('}\\n\\n')",
  "    out.write('echo \"=== Resolving modules ===\"\\n')",
  "    seen = set()",
  "    for stage in bench.stages:",
  "        out.write(f'\\n# Stage: {stage.id}\\n')",
  "        for module in stage.modules:",
  "            commit = module.repository.commit",
  "            url = module.repository.url",
  "            repo = _repo_name(url)",
  "            key = (repo, commit[:7])",
  "            if key not in seen:",
  "                seen.add(key)",
  "                out.write(f'clone_module \"{module.id}\" \"{url}\" \"{repo}\" \"{commit[:7]}\"\\n')",
  "    if bench.metric_collectors:",
  "        out.write('\\n# Metric collectors\\n')",
  "        for mc in bench.metric_collectors:",
  "            commit = mc.repository.commit",
  "            url = mc.repository.url",
  "            repo = _repo_name(url)",
  "            key = (repo, commit[:7])",
  "            if key not in seen:",
  "                seen.add(key)",
  "                out.write(f'clone_module \"{mc.id}\" \"{url}\" \"{repo}\" \"{commit[:7]}\"\\n')",
  "    out.write('\\necho \"=== All modules resolved ===\"\\n\\n')",
  "    # snakemake invocation",
  "    out.write('# ── Snakemake execution ────────────────────────────────────────────────\\n')",
  "    out.write('echo \"=== Running snakemake (cores=$CORES) ===\"\\n')",
  "    flags = ['--snakefile Snakefile', '--cores \"$CORES\"', '--rerun-incomplete']",
  "    if backend == 'conda':       flags.append('--use-conda')",
  "    elif backend == 'apptainer': flags.append('--use-singularity')",
  "    elif backend == 'envmodules':flags.append('--use-envmodules')",
  "    out.write('snakemake \\\\\\n')",
  "    for flag in flags[:-1]:",
  "        out.write(f'    {flag} \\\\\\n')",
  "    out.write(f'    {flags[-1]}\\n')",
  "    return out.getvalue()",
  "",
  "def yaml_to_snakefile(yaml_content):",
  "    try:",
  "        from omnibenchmark.model.benchmark import Benchmark",
  "        bench = Benchmark.from_yaml(yaml_content)",
  "        return {'ok': True, 'snakefile': _generate(bench), 'runner': _generate_runner(bench)}",
  "    except Exception as e:",
  "        import traceback",
  "        return {'ok': False, 'error': f'{type(e).__name__}: {e}',",
  "                'traceback': traceback.format_exc()}",
].join("\n");

async function init(wheelUrl) {
  try {
    self.postMessage({ type: "status", message: "Loading Pyodide runtime…" });
    pyodide = await loadPyodide();

    self.postMessage({ type: "status", message: "Loading pydantic / PyYAML…" });
    await pyodide.loadPackage(["pydantic", "pyyaml"]);

    self.postMessage({ type: "status", message: "Fetching omnibenchmark wheel…" });
    // Fetch the wheel in JS and write it to Pyodide's virtual FS.
    // Wheels are zip files — adding the path to sys.path lets zipimport handle it.
    // This completely avoids micropip and its download/resolution issues.
    const resp = await fetch(wheelUrl);
    if (!resp.ok) throw new Error(`Failed to fetch wheel: ${resp.status} ${resp.statusText}`);
    const wheelBytes = new Uint8Array(await resp.arrayBuffer());
    pyodide.FS.writeFile("/omnibenchmark.whl", wheelBytes);

    self.postMessage({ type: "status", message: "Initialising omnibenchmark…" });
    await pyodide.runPythonAsync(`
import sys, types

# Wheel is a zip — zipimport picks it up automatically from sys.path
sys.path.insert(0, "/omnibenchmark.whl")

def _mock(name, **attrs):
    m = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(m, k, v)
    sys.modules[name] = m
    return m

# Mock every heavy / C-extension dep that omnibenchmark imports but we don't need.
# (We only use omnibenchmark.model.benchmark.Benchmark — pure pydantic + PyYAML.)
for _n in [
    "spdx_license_list",
    "matplotlib", "matplotlib.pyplot", "matplotlib.patches",
    "matplotlib.lines", "matplotlib.colors", "matplotlib.cm",
    "pydot",
    "humanfriendly",
    "filelock",
    "dulwich", "dulwich.repo", "dulwich.errors", "dulwich.porcelain",
    "snakemake",
    "copier",
    "dotenv", "python_dotenv",
    "tqdm", "tqdm.auto",
    "click",
    "rich", "rich.console", "rich.table", "rich.panel", "rich.progress",
]:
    _mock(_n)

sys.modules["spdx_license_list"].LICENSES = {}

# Smoke-test: this is all we actually call at runtime
from omnibenchmark.model.benchmark import Benchmark
`);

    self.postMessage({ type: "status", message: "Initialising preview engine…" });
    await pyodide.runPythonAsync(PREVIEW_PY);

    self.postMessage({ type: "ready" });
  } catch (e) {
    self.postMessage({ type: "result", ok: false, error: String(e) });
  }
}

async function convert(yaml) {
  if (!pyodide) return;
  try {
    // Pass yaml via globals to avoid any quoting/injection issues
    pyodide.globals.set("_yaml_input", yaml);
    const result = await pyodide.runPythonAsync("yaml_to_snakefile(_yaml_input)");
    const obj = result.toJs({ dict_converter: Object.fromEntries });
    result.destroy();
    self.postMessage({ type: "result", ok: obj.ok, snakefile: obj.snakefile, runner: obj.runner, error: obj.error });
  } catch (e) {
    self.postMessage({ type: "result", ok: false, error: e.message });
  }
}

self.onmessage = async ({ data }) => {
  if (data.type === "init")    await init(data.wheelUrl);
  if (data.type === "convert") await convert(data.yaml);
};
