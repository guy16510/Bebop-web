#!/usr/bin/env python3
import base64
import io
import tarfile
from pathlib import Path

root = Path.cwd().resolve()
parts = sorted((root / '.github' / 'recognition-payload').glob('part*'))
if not parts:
    raise SystemExit('Recognition payload parts were not found')
payload = ''.join(part.read_text().strip() for part in parts)
with tarfile.open(fileobj=io.BytesIO(base64.b64decode(payload)), mode='r:gz') as archive:
    for member in archive.getmembers():
        destination = (root / member.name).resolve()
        if root not in destination.parents:
            raise SystemExit(f'Unsafe archive member: {member.name}')
    archive.extractall(root)
print('Object recognition source payload extracted')
