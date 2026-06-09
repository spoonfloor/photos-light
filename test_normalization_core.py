import os
import unittest
from tempfile import TemporaryDirectory

from library_cleanliness import build_canonical_photo_path
from make_library_clean_v2 import _compute_photo_duplicate_key
from normalization_contract import expected_canonical_rel_path_from_db_date
from normalization_core import (
    NormalizationCoreDependencies,
    build_video_identity,
    duplicate_key_for_file,
    expected_canonical_rel_path,
)


class _HashCache:
    def __init__(self, content_hash):
        self.content_hash = content_hash

    def get_hash(self, _path):
        return self.content_hash, False


def _unused(*_args, **_kwargs):
    raise AssertionError("unexpected dependency call")


class NormalizationCoreTest(unittest.TestCase):
    def test_duplicate_key_matches_clean_v2_wrapper(self):
        content_hash = "abc12345" + ("0" * 56)

        self.assertEqual(
            duplicate_key_for_file("/tmp/not-read.jpg", fallback_hash=content_hash),
            _compute_photo_duplicate_key("/tmp/not-read.jpg", fallback_hash=content_hash),
        )

    def test_expected_canonical_path_matches_contract_and_library_helper(self):
        date_taken = "2026:04:12 09:30:15"
        content_hash = "abc12345" + ("0" * 56)

        self.assertEqual(
            expected_canonical_rel_path(date_taken, content_hash, ".JPG"),
            expected_canonical_rel_path_from_db_date(date_taken, content_hash, ".JPG"),
        )
        self.assertEqual(
            expected_canonical_rel_path(date_taken, content_hash, ".JPG"),
            build_canonical_photo_path(date_taken, content_hash, ".JPG")[0],
        )

    def test_video_identity_uses_shared_duplicate_key_and_canonical_path(self):
        date_taken = "2026:04:12 09:30:15"
        content_hash = "def67890" + ("1" * 56)

        with TemporaryDirectory() as tmpdir:
            source_path = os.path.join(tmpdir, "clip.MOV")
            with open(source_path, "wb") as handle:
                handle.write(b"video-bytes")

            deps = NormalizationCoreDependencies(
                library_path=tmpdir,
                hash_cache=_HashCache(content_hash),
                stage_photo_for_canonicalization=_unused,
                cleanup_staged_file=lambda _path: None,
                commit_staged_canonical_photo=_unused,
                categorize_processing_error=lambda error: ("error", str(error)),
                extract_exif_date=lambda _path: date_taken,
                write_video_metadata=_unused,
                finalize_mutated_media=_unused,
                compute_hash=_unused,
                get_dimensions=_unused,
                delete_thumbnail_for_hash=lambda _hash: None,
            )

            identity = build_video_identity(source_path, ext=".MOV", deps=deps)

        self.assertIsNotNone(identity)
        assert identity is not None
        self.assertEqual(identity.file_type, "video")
        self.assertEqual(identity.content_hash, content_hash)
        self.assertEqual(identity.duplicate_key, content_hash)
        self.assertEqual(identity.date_taken, date_taken)
        self.assertEqual(
            identity.relative_path,
            expected_canonical_rel_path(date_taken, content_hash, ".MOV"),
        )


if __name__ == "__main__":
    unittest.main()
