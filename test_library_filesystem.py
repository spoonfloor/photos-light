import os
import unittest
from tempfile import TemporaryDirectory

from library_filesystem import (
    finalize_library_layout,
    iter_library_walk,
    partition_library_files,
    quarantine_root_hidden,
    remove_noncanonical_trees,
)


class LibraryFilesystemTest(unittest.TestCase):
    def test_partition_library_files_splits_media_and_non_media(self):
        with TemporaryDirectory() as tmpdir:
            os.makedirs(os.path.join(tmpdir, "incoming"))
            media_path = os.path.join(tmpdir, "incoming", "photo.jpg")
            other_path = os.path.join(tmpdir, "incoming", "notes.txt")
            hidden_path = os.path.join(tmpdir, ".hidden", "secret.jpg")
            with open(media_path, "wb") as handle:
                handle.write(b"photo")
            with open(other_path, "wb") as handle:
                handle.write(b"notes")
            os.makedirs(os.path.dirname(hidden_path), exist_ok=True)
            with open(hidden_path, "wb") as handle:
                handle.write(b"hidden")

            partition = partition_library_files(tmpdir)

        self.assertEqual(set(partition.media_files), {media_path, hidden_path})
        self.assertEqual(partition.non_media_files, [other_path])

    def test_partition_library_files_classifies_dot_files_as_non_media(self):
        with TemporaryDirectory() as tmpdir:
            dotfile_path = os.path.join(tmpdir, "incoming", ".env")
            os.makedirs(os.path.dirname(dotfile_path), exist_ok=True)
            with open(dotfile_path, "wb") as handle:
                handle.write(b"secret")

            partition = partition_library_files(tmpdir)

        self.assertEqual(partition.non_media_files, [dotfile_path])

    def test_iter_library_walk_skips_infrastructure_subtrees(self):
        with TemporaryDirectory() as tmpdir:
            trash_path = os.path.join(tmpdir, ".trash", "errors", "old.txt")
            os.makedirs(os.path.dirname(trash_path), exist_ok=True)
            with open(trash_path, "wb") as handle:
                handle.write(b"already trashed")

            partition = partition_library_files(tmpdir)

        self.assertEqual(partition.media_files, [])
        self.assertEqual(partition.non_media_files, [])

    def test_quarantine_root_hidden_finds_git_and_dotfiles(self):
        with TemporaryDirectory() as tmpdir:
            os.makedirs(os.path.join(tmpdir, ".git", "objects"), exist_ok=True)
            with open(os.path.join(tmpdir, ".git", "HEAD"), "wb") as handle:
                handle.write(b"ref")
            with open(os.path.join(tmpdir, ".gitignore"), "wb") as handle:
                handle.write(b"*.pyc")
            os.makedirs(os.path.join(tmpdir, ".library"), exist_ok=True)

            quarantine_dirs, quarantine_files = quarantine_root_hidden(tmpdir)

        self.assertEqual(quarantine_dirs, [os.path.join(tmpdir, ".git")])
        self.assertEqual(quarantine_files, [os.path.join(tmpdir, ".gitignore")])

    def test_remove_noncanonical_trees_removes_empty_incoming_folder(self):
        with TemporaryDirectory() as tmpdir:
            os.makedirs(os.path.join(tmpdir, "2026", "2026-04-12"), exist_ok=True)
            os.makedirs(os.path.join(tmpdir, "incoming"), exist_ok=True)
            with open(os.path.join(tmpdir, "2026", "2026-04-12", "img.jpg"), "wb") as handle:
                handle.write(b"photo")

            removed = remove_noncanonical_trees(tmpdir)

            self.assertEqual(removed, 1)
            self.assertFalse(os.path.exists(os.path.join(tmpdir, "incoming")))
            self.assertTrue(os.path.exists(os.path.join(tmpdir, "2026", "2026-04-12", "img.jpg")))

    def test_remove_noncanonical_trees_removes_nested_project_folders(self):
        with TemporaryDirectory() as tmpdir:
            os.makedirs(os.path.join(tmpdir, "2026", "2026-04-12"), exist_ok=True)
            os.makedirs(os.path.join(tmpdir, "static", "js"), exist_ok=True)
            os.makedirs(os.path.join(tmpdir, "Photo Library copy", "2025", "2025-11-11"), exist_ok=True)
            with open(os.path.join(tmpdir, "2026", "2026-04-12", "img.jpg"), "wb") as handle:
                handle.write(b"photo")

            removed = remove_noncanonical_trees(tmpdir)

            self.assertEqual(removed, 2)
            self.assertFalse(os.path.exists(os.path.join(tmpdir, "static")))
            self.assertFalse(os.path.exists(os.path.join(tmpdir, "Photo Library copy")))

    def test_finalize_library_layout_returns_remaining_non_media(self):
        with TemporaryDirectory() as tmpdir:
            notes_path = os.path.join(tmpdir, "notes.txt")
            with open(notes_path, "wb") as handle:
                handle.write(b"notes")

            removed, stragglers = finalize_library_layout(tmpdir)

        self.assertEqual(removed, 0)
        self.assertEqual(stragglers, [notes_path])

    def test_iter_library_walk_matches_partition_scope(self):
        with TemporaryDirectory() as tmpdir:
            with open(os.path.join(tmpdir, "readme.txt"), "wb") as handle:
                handle.write(b"readme")

            partition = partition_library_files(tmpdir)
            walk_files = []
            for root, _dirs, files in iter_library_walk(tmpdir):
                for filename in files:
                    if filename != ".DS_Store":
                        walk_files.append(os.path.join(root, filename))

        self.assertEqual(
            set(walk_files),
            set(partition.media_files) | set(partition.non_media_files),
        )


if __name__ == "__main__":
    unittest.main()
