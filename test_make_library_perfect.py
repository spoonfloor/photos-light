import os
import unittest
from datetime import datetime
from tempfile import TemporaryDirectory

from library_layout import canonical_db_path, detect_existing_db_path, is_library_metadata_file
from make_library_perfect import (
    DBNormalizationEngine,
    IGNORED_LIBRARY_FILES,
    LibraryCleaner,
    canonical_relative_path,
    in_infrastructure,
    is_day_folder_name,
    is_year_folder_name,
    parse_metadata_datetime,
    root_entry_allowed,
)


class MakeLibraryPerfectHelpersTest(unittest.TestCase):
    def test_parse_metadata_datetime_normalizes_exif_string(self):
        normalized, parsed = parse_metadata_datetime("2026:04:12 09:30:15", 0)
        self.assertEqual(normalized, "2026:04:12 09:30:15")
        self.assertEqual(parsed, datetime(2026, 4, 12, 9, 30, 15))

    def test_parse_metadata_datetime_falls_back_to_timestamp(self):
        normalized, parsed = parse_metadata_datetime(None, 0)
        expected = datetime.fromtimestamp(0)
        self.assertEqual(normalized, expected.strftime("%Y:%m:%d %H:%M:%S"))
        self.assertEqual(parsed, expected)

    def test_canonical_relative_path_uses_expected_layout(self):
        rel_path = canonical_relative_path(datetime(2026, 4, 12, 9, 30, 15), "abc1234", ".JPG")
        self.assertEqual(rel_path, "2026/2026-04-12/img_20260412_abc1234.jpg")

    def test_year_and_day_folder_validation(self):
        self.assertTrue(is_year_folder_name("2026"))
        self.assertFalse(is_year_folder_name("26"))
        self.assertTrue(is_day_folder_name("2026", "2026-04-12"))
        self.assertFalse(is_day_folder_name("2026", "2026-13-99"))
        self.assertFalse(is_day_folder_name("2026", "misc"))

    def test_root_entry_allowlist(self):
        self.assertTrue(root_entry_allowed(".library", True))
        self.assertTrue(root_entry_allowed(".trash", True))
        self.assertTrue(root_entry_allowed("2026", True))
        self.assertIn(".DS_Store", IGNORED_LIBRARY_FILES)
        self.assertTrue(root_entry_allowed(".DS_Store", False))
        self.assertFalse(root_entry_allowed("photo_library.db", False))
        self.assertFalse(root_entry_allowed("notes.txt", False))
        self.assertFalse(root_entry_allowed(".hidden", True))

    def test_infrastructure_detection(self):
        self.assertTrue(in_infrastructure(".trash/duplicates/file.jpg"))
        self.assertTrue(in_infrastructure(".logs/run.jsonl"))
        self.assertTrue(in_infrastructure(".library/photo_library.db"))
        self.assertFalse(in_infrastructure("2026/2026-04-12/img_20260412_abc1234.jpg"))

    def test_library_metadata_detection_prefers_hidden_db(self):
        with TemporaryDirectory() as tmpdir:
            hidden_db = canonical_db_path(tmpdir)
            os.makedirs(os.path.dirname(hidden_db), exist_ok=True)
            with open(hidden_db, "w", encoding="utf-8"):
                pass

            self.assertEqual(detect_existing_db_path(tmpdir), hidden_db)

    def test_library_metadata_allowlist(self):
        self.assertTrue(is_library_metadata_file("photo_library.db"))
        self.assertTrue(is_library_metadata_file("photo_library.db-wal"))
        self.assertTrue(is_library_metadata_file("photo_library.db-shm"))
        self.assertFalse(is_library_metadata_file("notes.txt"))

    def test_db_normalization_engine_alias_exists(self):
        self.assertTrue(issubclass(DBNormalizationEngine, LibraryCleaner))


if __name__ == "__main__":
    unittest.main()
