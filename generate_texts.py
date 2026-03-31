
import os, re

TEXT_EXTENSIONS = {'.txt', '.ara1', '.ara2', '.per1', '.per2', '.mArkdown', '.completed', '.md', 'markdown', '.inProgress'}

texts = []

for author_dir in sorted(os.listdir('data')):
    author_path = os.path.join('data', author_dir)
    if not os.path.isdir(author_path) or author_dir.startswith('.'):
        continue

    # Walk recursively through all subdirectories
    for root, dirs, files in os.walk(author_path):
        # Skip hidden directories
        dirs[:] = [d for d in sorted(dirs) if not d.startswith('.')]

        for fname in sorted(files):
            if fname.startswith('.'):
                continue
            name, ext = os.path.splitext(fname)
            # Handle double extensions like .completed
            if ext not in TEXT_EXTENSIONS:
                # Try stripping one more extension e.g. file.ara1.completed
                name2, ext2 = os.path.splitext(name)
                if ext2 in TEXT_EXTENSIONS:
                    name, ext = name2, ext2 + ext  # keep full name
                else:
                    continue

            txt_path = os.path.join(root, fname).replace('\\', '/')
            base = fname  # full filename including extension for ID
            parts = name.split('.')
            author_id  = parts[0] if len(parts) > 0 else ''
            book_title = parts[1] if len(parts) > 1 else name
            edition    = parts[2] if len(parts) > 2 else ''

            lang = detect_lang(fname, os.path.splitext(fname)[1])

            # Look for matching .yml metadata in a book subdirectory
            yml_path = None
            book_subdir = os.path.join(author_path, f'{author_id}.{book_title}')
            if os.path.isdir(book_subdir):
                for yf in sorted(os.listdir(book_subdir)):
                    if yf.endswith('.yml') and edition and edition in yf:
                        yml_path = os.path.join(book_subdir, yf).replace('\\', '/')
                        break
                if not yml_path:
                    for yf in sorted(os.listdir(book_subdir)):
                        if yf.endswith('.yml'):
                            yml_path = os.path.join(book_subdir, yf).replace('\\', '/')
                            break

            nice_title = re.sub(r'([A-Z])', r' \1', book_title).strip()
            text_id    = re.sub(r'[^a-z0-9]+', '_', fname.lower()).strip('_')

            entry = [
                f"  - id: {text_id}",
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
