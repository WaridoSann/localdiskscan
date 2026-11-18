#!/usr/bin/env python3
"""Package the current web interface with the provided portable Windows runtime."""

import argparse
import copy
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import struct
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

PROJECT = Path(__file__).resolve().parents[1]
APP_ROOT = PurePosixPath('LocalDiskAnalyzer')
WEB_PREFIX = 'LocalDiskAnalyzer/_internal/local_disk_analyzer/web/'
FIXED_DATE = (2026, 1, 1, 0, 0, 0)
README = '''Localdisk — Windows 64-bit

1. Right-click the downloaded ZIP and select Extract all.
2. Open the extracted folder, then the LocalDiskAnalyzer folder.
3. Double-click LocalDiskAnalyzer.exe. Your browser opens automatically.
4. Click Scan C:\\.

You do not need to install Git, Python, or Node.js, or start a server manually.
Keep the _internal folder next to LocalDiskAnalyzer.exe.

This preview is not digitally signed. If Windows SmartScreen displays
Windows protected your PC, confirm that you obtained the file from the
project repository. If you trust the download, choose More info > Run anyway.

For fewer permission errors, close the application, right-click
LocalDiskAnalyzer.exe and select Run as administrator. Some protected
or locked Windows files can still be inaccessible.

Project: https://github.com/WaridoSann/localdiskscan
The Windows runtime is preserved from the original provided package.
The package has not been executed on Windows in the preparation environment.
'''


def digest(data):
    return hashlib.sha256(data).hexdigest()


def is_application_readme(info, package):
    file = PurePosixPath(info.filename)
    if info.is_dir() or file.parent != APP_ROOT or file.suffix.lower() != '.md':
        return False
    return package.read(info).lstrip().startswith((b'LOCALDISK', b'# Localdisk'))


def write_asset(package, name, data):
    info = ZipInfo(name, date_time=FIXED_DATE)
    info.compress_type = ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    package.writestr(info, data, compresslevel=9)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=PROJECT / 'release')
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    source = PROJECT / 'distribution' / 'windows'
    manifest = json.loads((source / 'manifest.json').read_text())
    base = output / 'base-runtime.zip'
    with base.open('wb') as target:
        for name in manifest['parts']:
            part = source / name
            if part.resolve().parent != source.resolve():
                raise ValueError('Invalid runtime part path')
            with part.open('rb') as stream:
                shutil.copyfileobj(stream, target)
    base_data = base.read_bytes()
    if len(base_data) != manifest['size'] or digest(base_data) != manifest['sha256']:
        raise ValueError('The base Windows runtime failed its size or SHA-256 check')
    web_root = PROJECT / 'local_disk_analyzer' / 'web'
    web_files = {file.relative_to(web_root).as_posix(): file.read_bytes()
                 for file in sorted(web_root.rglob('*')) if file.is_file()}
    for required in ('index.html', 'app.js', 'style.css', 'treemap.js', 'fonts/IBMPlexSans.ttf', 'fonts/OFL.txt'):
        if required not in web_files:
            raise ValueError('Missing web asset: ' + required)
    archive = output / 'LocalDiskAnalyzer-win-x64.zip'
    with ZipFile(base) as original, ZipFile(archive, 'w', compression=ZIP_DEFLATED) as package:
        for info in original.infolist():
            if info.filename.startswith(WEB_PREFIX) or is_application_readme(info, original):
                continue
            package.writestr(copy.copy(info), original.read(info))
        for name, data in web_files.items():
            write_asset(package, WEB_PREFIX + name, data)
        write_asset(package, 'LocalDiskAnalyzer/README.txt', README.encode('utf-8'))
    unchanged = 0
    with ZipFile(base) as original, ZipFile(archive) as package:
        if package.testzip() is not None:
            raise ValueError('The packaged archive failed its CRC check')
        for info in original.infolist():
            if info.filename.startswith(WEB_PREFIX) or is_application_readme(info, original):
                continue
            if package.read(info.filename) != original.read(info):
                raise ValueError('A runtime file changed: ' + info.filename)
            if not info.is_dir():
                unchanged += 1
        for name, data in web_files.items():
            if package.read(WEB_PREFIX + name) != data:
                raise ValueError('A packaged web asset differs: ' + name)
        executable = package.read('LocalDiskAnalyzer/LocalDiskAnalyzer.exe')
        pe_offset = struct.unpack_from('<I', executable, 0x3c)[0]
        if executable[:2] != b'MZ' or executable[pe_offset:pe_offset + 4] != b'PE\0\0':
            raise ValueError('Invalid Windows executable')
        if struct.unpack_from('<H', executable, pe_offset + 4)[0] != 0x8664:
            raise ValueError('The Windows executable is not x64')
        certificate = struct.unpack_from('<II', executable, pe_offset + 24 + 112 + 8 * 4)
    archive_digest = digest(archive.read_bytes())
    report = {
        'filename': archive.name,
        'size': archive.stat().st_size,
        'archive_sha256': archive_digest,
        'base_runtime_sha256': manifest['sha256'],
        'executable_sha256': digest(executable),
        'architecture': 'x64',
        'digitally_signed': bool(certificate[0] and certificate[1]),
        'unchanged_runtime_files': unchanged,
        'web_files': {name: digest(data) for name, data in web_files.items()},
        'windows_executable_run': False,
    }
    (output / 'SHA256SUMS.txt').write_text(archive_digest + '  ' + archive.name + '\n')
    (output / 'BUILD-INFO.json').write_text(json.dumps(report, indent=2) + '\n')
    print('Created:', archive)
    print('Unchanged Windows runtime files:', unchanged)
    print('Current web assets verified:', len(web_files))
    print('SHA-256:', archive_digest)


if __name__ == '__main__':
    main()
