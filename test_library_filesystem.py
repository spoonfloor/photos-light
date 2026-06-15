import os
import sqlite3
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

from clean_library_media_utils import verify_media_file as real_verify_media_file

from library_filesystem import (
    ensure_blocking_audit_prep,
    finalize_library_layout,
    iter_library_walk,
    move_file_to_category_trash,
    partition_library_files,
    prune_empty_year_subfolders,
    quarantine_root_hidden,
    remove_misplaced_infrastructure_trees,
    remove_noncanonical_trees,
)
from library_layout import canonical_db_path
from db_schema import create_database_schema


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

    def test_quarantine_root_hidden_keeps_hidden_dirs_with_media(self):
        with TemporaryDirectory() as tmpdir:
            hidden_media_path = os.path.join(tmpdir, ".hidden-album", "deep", "photo.jpg")
            os.makedirs(os.path.dirname(hidden_media_path), exist_ok=True)
            with open(hidden_media_path, "wb") as handle:
                handle.write(b"hidden-photo")
            with open(os.path.join(tmpdir, ".gitignore"), "wb") as handle:
                handle.write(b"*.pyc")

            quarantine_dirs, quarantine_files = quarantine_root_hidden(tmpdir)
            partition = partition_library_files(tmpdir)

        self.assertEqual(quarantine_dirs, [])
        self.assertEqual(quarantine_files, [os.path.join(tmpdir, ".gitignore")])
        self.assertEqual(partition.media_files, [hidden_media_path])

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

    def test_remove_misplaced_infrastructure_trees_deletes_nested_thumbnails(self):
        with TemporaryDirectory() as tmpdir:
            shard_dir = os.path.join(tmpdir, "1900", ".thumbnails", "03", "58")
            os.makedirs(shard_dir, exist_ok=True)
            os.makedirs(os.path.join(tmpdir, "1900", "1900-01-01"), exist_ok=True)
            with open(os.path.join(tmpdir, "1900", "1900-01-01", "img.jpg"), "wb") as handle:
                handle.write(b"photo")

            removed = remove_misplaced_infrastructure_trees(tmpdir)

            self.assertEqual(removed, 1)
            self.assertFalse(os.path.exists(os.path.join(tmpdir, "1900", ".thumbnails")))
            self.assertTrue(os.path.exists(os.path.join(tmpdir, "1900", "1900-01-01", "img.jpg")))

    def test_partition_library_files_ignores_misplaced_thumbnail_cache(self):
        with TemporaryDirectory() as tmpdir:
            os.makedirs(os.path.join(tmpdir, "1900", ".thumbnails", "03", "58"), exist_ok=True)
            cache_path = os.path.join(
                tmpdir,
                "1900",
                ".thumbnails",
                "03",
                "58",
                "035831671f5f0050deedac83e6c253b32bdcf1327d5846bcc3e00f9ca6f5863a.jpg",
            )
            with open(cache_path, "wb") as handle:
                handle.write(b"cache")

            partition = partition_library_files(tmpdir)

            self.assertEqual(partition.media_files, [])
            self.assertEqual(partition.non_media_files, [])

    def test_prune_empty_year_subfolders_removes_nested_empty_year_tree(self):
        with TemporaryDirectory() as tmpdir:
            nested_day = os.path.join(tmpdir, "1900", "1900", "1900-01-01")
            os.makedirs(nested_day, exist_ok=True)
            os.makedirs(os.path.join(tmpdir, "1900", "1900-01-01"), exist_ok=True)
            with open(os.path.join(tmpdir, "1900", "1900-01-01", "img.jpg"), "wb") as handle:
                handle.write(b"photo")

            removed = prune_empty_year_subfolders(tmpdir)

            self.assertGreaterEqual(removed, 2)
            self.assertFalse(os.path.exists(nested_day))
            self.assertFalse(os.path.exists(os.path.join(tmpdir, "1900", "1900")))

    def test_finalize_library_layout_clears_misplaced_infrastructure_debris(self):
        with TemporaryDirectory() as tmpdir:
            os.makedirs(os.path.join(tmpdir, "1900", ".thumbnails", "03", "58"), exist_ok=True)
            os.makedirs(os.path.join(tmpdir, "1900", "1900", "1900-01-01"), exist_ok=True)
            os.makedirs(os.path.join(tmpdir, "1900", "1900-01-01"), exist_ok=True)
            with open(os.path.join(tmpdir, "1900", "1900-01-01", "img.jpg"), "wb") as handle:
                handle.write(b"photo")

            removed, stragglers = finalize_library_layout(tmpdir)

            self.assertGreaterEqual(removed, 1)
            self.assertEqual(stragglers, [])
            self.assertFalse(os.path.exists(os.path.join(tmpdir, "1900", ".thumbnails")))
            self.assertFalse(os.path.exists(os.path.join(tmpdir, "1900", "1900")))

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

    def test_move_file_to_category_trash_preserves_relative_path(self):
        with TemporaryDirectory() as tmpdir:
            trash_dir = os.path.join(tmpdir, ".trash")
            source_path = os.path.join(tmpdir, "incoming", "notes.txt")
            os.makedirs(os.path.dirname(source_path), exist_ok=True)
            with open(source_path, "wb") as handle:
                handle.write(b"notes")

            trash_path = move_file_to_category_trash(tmpdir, trash_dir, source_path, "errors")

            self.assertFalse(os.path.exists(source_path))
            self.assertTrue(os.path.exists(trash_path))
            self.assertEqual(
                trash_path,
                os.path.join(trash_dir, "errors", "incoming", "notes.txt"),
            )

    def test_ensure_blocking_audit_prep_quarantines_metadata_and_trashes_orphans(self):
        with TemporaryDirectory() as tmpdir:
            db_path = canonical_db_path(tmpdir)
            metadata_dir = os.path.dirname(db_path)
            os.makedirs(metadata_dir, exist_ok=True)
            conn = sqlite3.connect(db_path)
            create_database_schema(conn.cursor())
            canonical_path = "2026/2026-01-27/img_20260127_deadbeef.png"
            os.makedirs(os.path.join(tmpdir, "2026", "2026-01-27"), exist_ok=True)
            with open(os.path.join(tmpdir, canonical_path), "wb") as handle:
                handle.write(b"valid-photo")
            conn.execute(
                """
                INSERT INTO photos (
                    original_filename, current_path, date_taken, content_hash,
                    file_size, file_type, width, height
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "img.png",
                    canonical_path,
                    "2026:01:27 12:00:00",
                    "deadbeef" * 8,
                    11,
                    "photo",
                    1,
                    1,
                ),
            )
            conn.commit()

            fake_png = os.path.join(tmpdir, "03_fake-png.png")
            with open(fake_png, "w", encoding="utf-8") as handle:
                handle.write("not really a png")

            orphan_jpg = os.path.join(tmpdir, "incoming", "orphan.jpg")
            os.makedirs(os.path.dirname(orphan_jpg), exist_ok=True)
            with open(orphan_jpg, "wb") as handle:
                handle.write(b"orphan-photo")

            stray_zip = os.path.join(metadata_dir, "photo_library.db.zip")
            with open(stray_zip, "w", encoding="utf-8") as handle:
                handle.write("backup bytes")

            def verify_side_effect(path):
                if path.endswith("orphan.jpg"):
                    return True, "valid orphan"
                return real_verify_media_file(path)

            with patch("library_filesystem.verify_media_file", side_effect=verify_side_effect):
                stats = ensure_blocking_audit_prep(tmpdir, db_conn=conn, reason="test")
            conn.close()

            self.assertFalse(os.path.exists(fake_png))
            self.assertFalse(os.path.exists(orphan_jpg))
            self.assertFalse(os.path.exists(stray_zip))
            self.assertTrue(os.path.exists(os.path.join(tmpdir, canonical_path)))
            self.assertEqual(stats.trashed_corrupt, 1)
            self.assertEqual(stats.trashed_errors, 1)
            self.assertEqual(stats.trashed_orphans, 2)
            self.assertEqual(len(stats.quarantined_metadata), 1)
            self.assertTrue(
                os.path.exists(
                    os.path.join(tmpdir, ".trash", "corrupted", "03_fake-png.png")
                )
            )
            self.assertTrue(
                os.path.exists(
                    os.path.join(tmpdir, ".trash", "errors", "incoming", "orphan.jpg")
                )
            )
            self.assertTrue(
                any(path.endswith("photo_library.db.zip") for path in stats.quarantined_metadata)
            )


if __name__ == "__main__":
    unittest.main()
