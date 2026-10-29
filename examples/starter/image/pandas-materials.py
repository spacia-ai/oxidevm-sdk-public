"""Bind the actual image files to authenticated base sources and pinned Python sources."""
import copy
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_path(name):
    assert isinstance(name, str) and len(name) < 4096 and not name.startswith('/') and '\\' not in name
    assert name and all(p not in ('', '.', '..') for p in name.split('/'))
    return name


def python_owner(name):
    prefix = 'usr/lib/python3.12/site-packages/'
    if not name.startswith(prefix):
        return None
    relative = name[len(prefix):]
    if re.fullmatch(r'__pycache__/six\.cpython-312(?:\.opt-[12])?\.pyc', relative):
        return 'SPDXRef-Package-six'
    local = relative.split('/')[0]
    for package, pattern in [('numpy', r'numpy(?:/|$|-)'), ('pandas', r'pandas(?:/|$|-)'), ('python-dateutil', r'(?:dateutil$|python_dateutil-)'), ('pytz', r'pytz(?:$|-)'), ('tzdata', r'tzdata(?:$|-)'), ('six', r'six(?:\.py$|-)')]:
        if re.match(pattern, local):
            return 'SPDXRef-Package-' + package
    return None


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def pack(path, root):
    with path.open('wb') as raw, gzip.GzipFile(fileobj=raw, filename='', mode='wb', mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.PAX_FORMAT) as archive:
            for file in sorted(root.rglob('*')):
                name = safe_path(file.relative_to(root).as_posix())
                assert file.is_symlink() or file.is_file() or file.is_dir(), 'Unsupported guest file'
                info = archive.gettarinfo(str(file), './' + name)
                info.uid = info.gid = 1000 if name == 'workspace' or name.startswith('workspace/') else 0
                info.uname = info.gname = ''; info.mtime = 0; info.pax_headers = {}
                if info.isfile():
                    with file.open('rb') as content: archive.addfile(info, content)
                else: archive.addfile(info)


def prepare(job):
    recipe, output = Path(job['recipe']), Path(job['output'])
    root, evidence = output / 'rootfs', output / 'evidence'
    for archive in (root / 'usr/lib/python3.12/site-packages').rglob('*.a'):
        archive.unlink()
    evidence.mkdir(); (evidence / 'sources').mkdir(); (evidence / 'licenses').mkdir()
    lock = json.loads((recipe / 'python-inputs.lock.json').read_text())
    inputs = {x['filename']: x for x in lock['inputs']}
    assert digest(Path(job['baseArchive']).read_bytes()) == lock['base']['sha256']
    for name, pin in inputs.items():
        assert digest((recipe / '.cache/python-inputs' / safe_path(name)).read_bytes()) == pin['sha256'], 'Changed Python build input'
    base = job['base']; sbom = base['sbom']
    files_by_id = {f['SPDXID']: f for f in sbom['files']}
    old_files = {safe_path(f['fileName'].removeprefix('./')): f for f in sbom['files']}
    owners = {}
    for rel in sbom['relationships']:
        if rel['relationshipType'] == 'CONTAINS' and rel['relatedSpdxElement'] in files_by_id:
            name = files_by_id[rel['relatedSpdxElement']]['fileName'].removeprefix('./')
            owners.setdefault(name, set()).add(rel['spdxElementId'])
    packages = {p['SPDXID']: p for p in sbom['packages']}
    notices = {n['packageId']: n for n in base['notices']['notices']}
    decisions = {p['packageId']: p for p in base['policy']['packages']}
    sources = {p['packageId']: p for p in base['sources']}
    runtime = {r['name']: r for r in lock['runtime']}
    for name, item in runtime.items():
        pid = 'SPDXRef-Package-' + name
        packages[pid] = {'SPDXID': pid, 'name': name, 'versionInfo': item['version'], 'downloadLocation': inputs[item['archive']]['url'], 'filesAnalyzed': False, 'licenseConcluded': item['license'], 'licenseDeclared': item['license'], 'copyrightText': 'See accompanying upstream notices'}
        # The unmodified source archive retains nested notices, build-only grants, and all build inputs.
        source = recipe / '.cache/python-inputs' / item['archive']
        kit = output / ('source-' + name); kit.mkdir()
        shutil.copy2(source, kit / source.name)
        for path in recipe.iterdir():
            if path.is_file() and not path.name.startswith('.'): shutil.copy2(path, kit / path.name)
        texts = []
        with tarfile.open(source) as archive:
            for member in archive:
                if member.isfile() and not any(part in member.name.split('/') for part in ('vendored-meson', 'tests', 'doc', 'docs')) and re.search(r'(?:LICENSE|COPYING|NOTICE|LICENCE)', PurePosixPath(member.name).name, re.I):
                    assert member.size < 2 * 1024**2
                    original = archive.extractfile(member).read()
                    assert b'\0' not in original, 'Binary license material requires a separate original file: ' + member.name
                    texts.append(member.name + '\n' + original.decode('utf8'))
        if name == 'numpy':
            with tarfile.open(source) as archive:
                dragon = archive.extractfile('numpy-2.2.6/numpy/_core/src/multiarray/dragon4.c').read().decode('utf8')
                assert dragon.startswith('/*') and 'Permission is hereby granted' in dragon.split('*/', 1)[0]
                texts.append('dragon4.c: original MIT copyright and permission notice\n' + dragon.split('*/', 1)[0] + '*/')
        assert texts, 'Missing original license texts: ' + name
        notice = '\n\n'.join(texts)
        notices[pid] = {'packageId': pid, 'license': item['license'], 'text': notice}
        decisions[pid] = {'packageId': pid, 'license': item['license'], 'noticeSHA256': digest(notice.encode()), 'obligations': 'source'}
        destination = evidence / 'sources' / (name + '-' + item['version'] + '.tar.gz')
        pack(destination, kit)
        sources[pid] = {'packageId': pid, 'archive': str(destination), 'sha256': digest(destination.read_bytes())}
        shutil.rmtree(kit)
    # Match additional C++ runtime bytes against the exact pinned APK payload, never by filename alone.
    gcc_files = {}
    for apk in ('libgcc-15.2.0-r5.apk', 'libstdc++-15.2.0-r5.apk'):
        with tarfile.open(recipe / '.cache/python-inputs' / apk, ignore_zeros=True) as archive:
            for m in archive:
                if m.isfile() and m.name.startswith('usr/lib/'):
                    gcc_files[m.name] = digest(archive.extractfile(m).read())
                elif m.issym() and m.name.startswith('usr/lib/'):
                    gcc_files[m.name] = digest(m.linkname.encode())
    rows, relations, active = [], [], set()
    for path in sorted(root.rglob('*')):
        if path.is_dir() and not path.is_symlink(): continue
        name = safe_path(path.relative_to(root).as_posix())
        data = os.readlink(path).encode() if path.is_symlink() else path.read_bytes()
        sha = digest(data)
        previous = old_files.get(name)
        if previous and any(c['algorithm'] == 'SHA256' and c['checksumValue'] == sha for c in previous['checksums']):
            selected = owners[name]
        elif name in gcc_files and gcc_files[name] == sha:
            selected = {'SPDXRef-Package-gcc-runtime'}
        else:
            owner = python_owner(name)
            assert owner is not None and owner in packages, 'Unmapped or changed base file: ' + name
            selected = {owner}
            if data.startswith(b'\x7fELF'):
                selected.update({'SPDXRef-Package-gcc-runtime', 'SPDXRef-Package-musl-crt'})
        fid = 'SPDXRef-File-' + digest(name.encode())
        rows.append({'SPDXID': fid, 'fileName': name, 'checksums': [{'algorithm':'SHA256','checksumValue':sha},{'algorithm':'SHA1','checksumValue':hashlib.sha1(data).hexdigest()}]})
        for owner in sorted(selected):
            active.add(owner); relations.append({'spdxElementId':owner,'relationshipType':'CONTAINS','relatedSpdxElement':fid})
    assert len(rows) > 1000 and all('SPDXRef-Package-' + n in active for n in runtime)
    instructions = '# Rebuild Python + pandas starter\n\nVerify all pinned input hashes. Independently authenticate the docs-python base bundle and verify its rootfs archive digest. Base component source kits retain their exact upstream sources, Alpine recipes, patches and build inputs. Run prepare.ts with OXIDEVM_PANDAS_BASE_ROOTFS, then build Dockerfile offline. NumPy 2.2.6 and pandas 2.3.3 compile from the included source archives with the recorded toolchain. NumPy uses its internal BLAS/LAPACK fallback, SSE2 baseline and no CPU dispatch. No OpenBLAS, libgfortran, libquadmath or Bun is shipped. GCC runtime libraries use the GCC Runtime Library Exception. Compare two final rootfs file inventories and complete browser tests before distribution. Human review and release approval remain separate.\n'
    (evidence / 'BUILD.md').write_text(instructions)
    records = []
    for pid in sorted(active):
        assert pid in sources and pid in notices and pid in decisions
        source = sources[pid]; source_path = Path(source['archive']); assert digest(source_path.read_bytes()) == source['sha256']
        target = evidence / 'sources' / (source['sha256'] + '.tar.gz')
        if target != source_path and not target.exists(): os.link(source_path, target)
        records.append({'packageId':pid,'kind':'source','archive':{'path':str(target.relative_to(output)),'sha256':source['sha256']},'buildInstructionsFile':'evidence/BUILD.md'})
        if 'buildInstructions' in source: shutil.copy2(source['buildInstructions'], evidence / 'sources' / (pid + '.BUILD.md'))
        (evidence / 'licenses' / (packages[pid]['name'] + '.txt')).write_text(notices[pid]['text'])
    save(evidence / 'sbom.spdx.json', {**sbom,'name':'oxidevm-starter-pandas-0.0.1','documentNamespace':'https://oxidevm.dev/sbom/pandas/'+digest(json.dumps(rows,sort_keys=True).encode()),'packages':[packages[p] for p in sorted(active)],'files':rows,'relationships':relations})
    save(evidence / 'sbom.cdx.json', {'bomFormat':'CycloneDX','specVersion':'1.6','version':1,'components':[{'type':'library','name':packages[p]['name'],'version':packages[p]['versionInfo'],'bom-ref':p,'licenses':[{'expression':packages[p]['licenseConcluded']}]} for p in sorted(active)]})
    save(evidence / 'notices.json', {'schemaVersion':1,'notices':[notices[p] for p in sorted(active)]})
    save(evidence / 'sources.json', {'schemaVersion':1,'packages':records})
    save(evidence / 'policy.json', {**base['policy'],'validator':'Authenticated base file hashes, pinned GCC APK payload and source-built Python package inventory','packages':[decisions[p] for p in sorted(active)]})
    save(output / 'components.json', [{'name':packages[p]['name'],'version':packages[p]['versionInfo'],'license':packages[p]['licenseConcluded']} for p in sorted(active)])
    (evidence / 'OPEN-SOURCE-NOTICE.md').write_text('# Python + pandas starter image\n\nThis image is a collection of separately licensed programs. Complete original license texts and copyright notices are in licenses/. Corresponding sources and build inputs are in sources/. The SDK and starter application use Apache-2.0. The proprietary OxideVM engine has separate terms. Engine terms do not limit component license rights. NumPy and pandas execute as native Linux x86-64 libraries. The image excludes BusyBox, Bun, libquadmath and libgfortran. GCC runtime libraries retain their explicit Runtime Library Exception. Automated checks do not grant legal or publication approval.\n')
    archive = output / 'rootfs.tar.gz'; pack(archive, root)
    save(output / 'recipe.json', {'mode':'userspace','id':'oxidevm-starter-pandas','version':'0.0.1','cpuProfile':'x86-64-v2','sourceDateEpoch':1792886400,'resources':{'memoryMiB':1536},'source':{'kind':'archive','artifact':{'path':'rootfs.tar.gz','sha256':digest(archive.read_bytes())}},'evidence':{'sbom':{'kind':'file','path':'evidence/sbom.spdx.json'},'noticesFile':'evidence/notices.json','correspondingSourcesFile':'evidence/sources.json','licensePolicyFile':'evidence/policy.json'},'smokeTest':{'command':'/usr/bin/python3','args':['-c','import pandas,numpy; print(pandas.__version__,numpy.__version__)'],'expectedExitCode':0,'stdoutIncludes':'2.3.3 2.2.6'}})
    (evidence / 'SHA256SUMS').write_text(''.join(digest(p.read_bytes())+'  '+p.relative_to(evidence).as_posix()+'\n' for p in sorted(evidence.rglob('*')) if p.is_file()))
    print(json.dumps({'files':len(rows),'components':len(active),'published':False}))


if __name__ == '__main__':
    if sys.argv[1:] == ['--self-test']:
        assert python_owner('usr/lib/python3.12/site-packages/numpy/core.so') == 'SPDXRef-Package-numpy'
        assert python_owner('usr/lib/python3.12/site-packages/unknown/core.so') is None
        assert python_owner('usr/bin/python3') is None
        for path in ('../escape','/absolute','a/../../b','a\\b'):
            try: safe_path(path)
            except AssertionError: pass
            else: raise AssertionError('Accepted escaping path')
    else:
        assert len(sys.argv) == 2
        prepare(json.loads(Path(sys.argv[1]).read_text()))
