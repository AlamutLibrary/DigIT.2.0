
import os, re

texts = []

for author_dir in sorted(os.listdir('data')):
    author_path = os.path.join('data', author_dir)
    if not os.path.isdir(author_path) or author_dir.startswith('.'):
        continue

    for fname in sorted(os.listdir(author_path)):
        if not fname.endswith('.txt') or fname.startswith('.'):
            continue

        txt_path = os.path.join(author_path, fname).replace('\\','/')
        base = fname.replace('.txt','')
        parts = base.split('.')
        author_id  = parts[0] if len(parts) > 0 else ''
        book_title = parts[1] if len(parts) > 1 else base
        edition    = parts[2] if len(parts) > 2 else ''

        lang = 'fa' if '-per' in edition.lower() else 'ar'

        yml_path = None
        book_subdir = os.path.join(author_path, f'{author_id}.{book_title}')
        if os.path.isdir(book_subdir):
            for yf in sorted(os.listdir(book_subdir)):
                if yf.endswith('.yml') and edition in yf:
                    yml_path = os.path.join(book_subdir, yf).replace('\\','/')
                    break
            if not yml_path:
                for yf in sorted(os.listdir(book_subdir)):
                    if yf.endswith('.yml'):
                        yml_path = os.path.join(book_subdir, yf).replace('\\','/')
                        break

        nice_title = re.sub(r'([A-Z])', r' \1', book_title).strip()

        entry = [
            f"  - id: {base.lower().replace('.','_').replace('-','_')}",
            f"    title: \"{nice_title}\"",
            f"    author: \"{author_id}\"",
            f"    language: {lang}",
            f"    branch: master",
            f"    raw_text_path: \"{txt_path}\"",
        ]
        if yml_path:
            entry.append(f"    github_path: \"{yml_path}\"")

        texts.append('\n'.join(entry))

output = "texts:\n\n" + '\n\n'.join(texts) + '\n'

with open('texts.yml', 'w', encoding='utf-8') as f:
    f.write(output)

print(f"Done — {len(texts)} texts written to texts.yml")
#PYEOF
