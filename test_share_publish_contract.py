"""Share publish contract tests."""

from __future__ import annotations

import inspect
import unittest

import share_albums


class SharePublishContractTest(unittest.TestCase):
    def test_insert_album_requires_access_token(self):
        source = inspect.getsource(share_albums.insert_album)
        self.assertIn("access_token", source)

    def test_publish_share_album_requires_access_token(self):
        source = inspect.getsource(share_albums.iter_publish_share_album)
        self.assertIn("access_token", source)
        self.assertIn('"access_token"', source.split('"complete"', 1)[1])

    def test_publish_converts_non_native_stills_via_delivery_plan(self):
        source = inspect.getsource(share_albums.iter_publish_share_album)
        self.assertIn("plan_share_delivery", source)
        self.assertIn("still_image_to_jpeg_buffer", source)
        self.assertIn("delivery.delivered_filename", source)
        self.assertIn('delivery.action == "still_jpeg"', source)

    def test_publish_transcodes_video_via_delivery_plan(self):
        source = inspect.getsource(share_albums.iter_publish_share_album)
        self.assertIn('delivery.action == "video_transcode"', source)
        self.assertIn("video_to_browser_mp4_buffer", source)
        self.assertIn("delivery.storage_name", source)

    def test_publish_storage_prefix_uses_access_token(self):
        source = inspect.getsource(share_albums.iter_publish_share_album)
        self.assertIn('f"{access_token}/', source)

    def test_share_publish_streams_progress_via_iter(self):
        with open("app.py", encoding="utf-8") as handle:
            text = handle.read()
        publish_block = text.split("def share_publish():", 1)[1].split("\n\n\n", 1)[0]
        self.assertIn("iter_publish_share_album", publish_block)
        self.assertIn("yield emit(event_name, payload)", publish_block)

    def test_app_prepare_includes_access_token(self):
        with open("app.py", encoding="utf-8") as handle:
            text = handle.read()
        prepare_block = text.split("def share_prepare():", 1)[1].split("def share_publish():", 1)[0]
        self.assertIn("partition_share_photos_by_size", prepare_block)
        self.assertIn('"status": "oversized"', prepare_block)
        self.assertIn("'status': 'ready'", prepare_block)
        self.assertIn("generate_access_token()", prepare_block)
        self.assertIn("'access_token': access_token", prepare_block)

    def test_share_flow_passes_access_token_on_publish(self):
        with open("static/js/shareFlow.js", encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("accessToken: prepared.access_token", text)
        self.assertIn("access_token: activeSession.accessToken", text)

    def test_share_overlay_uses_single_action_footer(self):
        with open("static/fragments/shareOverlay.html", encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn('id="shareOverlayActions"', text)
        self.assertNotIn('id="shareOverlayCompleteActions"', text)
        self.assertIn('id="shareOverlayDoneBtn"', text)
        self.assertIn("hidden", text.split("shareOverlayDoneBtn", 1)[1])

    def test_share_flow_toggles_ctas_by_state(self):
        with open("static/js/shareFlow.js", encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("showPreflightActions", text)
        self.assertIn("showProgressActions", text)
        self.assertIn("showCompleteActions", text)
        self.assertIn("showFailedActions", text)
        self.assertIn("setShareButtonDisabled(true)", text)
        self.assertIn("shareOverlayDoneBtn", text)
        self.assertIn("shareOverlayRetryBtn", text)

    def test_share_overlay_has_failed_state(self):
        with open("static/fragments/shareOverlay.html", encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn('id="shareOverlayFailed"', text)
        self.assertIn('id="shareOverlayFailedMessage"', text)
        self.assertIn('id="shareOverlayRetryBtn"', text)

    def test_share_flow_verifies_outcome_before_failure_ui(self):
        with open("static/js/shareFlow.js", encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("/api/share/publish-outcome", text)
        self.assertIn("fetchPublishOutcome", text)
        self.assertIn("heartbeat", text.split("async function publishShare", 1)[1])
        self.assertIn("logSharePublishFailure", text)
        self.assertIn("createSharePublishError", text)
        self.assertIn("showFailedState", text)
        self.assertIn("SHARE_FAILURE_MESSAGE_GENERIC", text)
        self.assertIn("SHARE_FAILURE_MESSAGE_ORPHAN", text)
        self.assertIn("Sharing error", text)
        self.assertIn("delete it first, then try again", text)
        confirm_block = text.split("async function handleShareConfirm()", 1)[1].split(
            "function wireOverlayControls", 1
        )[0]
        self.assertNotIn("showPreflightState()", confirm_block)
        self.assertNotIn("cleanupShareSession", confirm_block)

    def test_publish_outcome_lives_in_share_albums_module(self):
        source = inspect.getsource(share_albums.get_share_publish_outcome)
        self.assertIn('"complete"', source)
        self.assertIn('"partial"', source)
        self.assertIn('"none"', source)

    def test_share_overlay_uses_title_link_toggle(self):
        with open("static/fragments/shareOverlay.html", encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn('class="share-title-link"', text)
        self.assertIn('id="shareOverlayTitleToggle"', text)
        self.assertNotIn('type="checkbox"', text)

    def test_share_flow_uses_placeholder_title_and_immediate_eta(self):
        with open("static/js/shareFlow.js", encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("titleInput.placeholder = session.suggestedTitle", text)
        self.assertIn("titleInput.value = ''", text)
        self.assertIn("Time remaining: Calculating", text)
        self.assertNotIn("Total time remaining", text)

    def test_share_albums_list_and_delete_live_in_share_albums_module(self):
        source = inspect.getsource(share_albums.list_share_albums)
        self.assertIn("order=created_at.desc", source)
        self.assertIn("format_album_label", source)

        delete_source = inspect.getsource(share_albums.delete_share_album)
        self.assertIn("cleanup_share_album", delete_source)
        cleanup_source = inspect.getsource(share_albums.cleanup_share_album)
        self.assertIn("_delete_album_catalog_and_storage", cleanup_source)
        delete_impl_source = inspect.getsource(share_albums._delete_album_catalog_and_storage)
        collect_source = inspect.getsource(share_albums._collect_album_storage_paths)
        self.assertIn("_delete_storage_paths", delete_impl_source)
        self.assertIn("_list_all_storage_files", inspect.getsource(share_albums))
        self.assertIn('"prefixes"', inspect.getsource(share_albums._delete_storage_paths))
        self.assertIn('"/rest/v1/albums?id=eq.', delete_impl_source)
        self.assertIn("_delete_storage_paths", delete_impl_source.split('"/rest/v1/albums?id=eq.', 1)[1])
        self.assertNotIn("_list_storage_paths", cleanup_source)
        self.assertIn("display_path", collect_source)
        self.assertNotIn("revoked_at", cleanup_source)

    def test_publish_keeps_partial_album_on_failure_for_resume(self):
        source = inspect.getsource(share_albums.iter_publish_share_album)
        failure_tail = source.split("_log_share_failure", 1)[1]
        self.assertNotIn("cleanup_share_album", failure_tail.split("def publish_share_album", 1)[0])
        self.assertIn("insert_album_photos([catalog_row])", source)
        self.assertIn("_get_completed_share_positions", source)
        self.assertIn("heartbeat", source)

    def test_share_publish_has_terminal_logging_and_retries(self):
        text = inspect.getsource(share_albums)
        self.assertIn('print(f"[share] {message}", flush=True)', text)
        self.assertIn("SHARE_STORAGE_UPLOAD_RETRIES", text)
        self.assertIn("SHARE_STORAGE_TIMEOUT_SEC", text)
        self.assertIn("class SharePublishError", text)
        self.assertIn("validate_photos_for_share", text)

    def test_app_exposes_share_album_routes(self):
        with open("app.py", encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("def share_albums_list():", text)
        self.assertIn("def share_album_delete(album_id):", text)
        self.assertIn("def share_cancel():", text)
        self.assertIn("def share_publish_outcome():", text)
        self.assertIn("validate_photos_for_share", text)
        self.assertIn("list_share_albums()", text)
        self.assertIn("delete_share_album(album_key)", text)
        self.assertIn("cleanup_share_album(", text)

    def test_share_flow_exposes_manage_links_entry(self):
        with open("static/js/shareFlow.js", encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("openManageLinks", text)
        self.assertIn("/api/share/albums", text)
        self.assertIn("/api/share/cancel", text)
        self.assertIn("shareManageOverlay.html", text)
        self.assertIn("manageShareLinksBtn", text)
        manage_block = text.split("const manageEnabled =", 1)[1].split(";", 1)[0]
        self.assertNotIn("hasDatabase", manage_block)
        self.assertNotIn("publishInProgress", manage_block)
        self.assertIn("publishAbortController", text)
        self.assertIn("cancelSharePublishWithRetry", text)
        self.assertIn("SHARE_CANCEL_CLEANUP_MAX_ATTEMPTS", text)
        self.assertIn("shareCancelCleanupFailureMessage", text)
        self.assertIn("Open Manage links and delete it manually", text)
        self.assertIn("pendingShareCancelCleanups", text)
        self.assertIn("shareManageTitle", text)
        self.assertIn("Manage links (${manageAlbums.length})", text)
        self.assertIn("showCheckingState", text)
        self.assertIn("showOversizeState", text)
        self.assertIn("shareOverlaySkipBtn", text)
        self.assertIn("handleShareSkipOversized", text)
        self.assertIn("skip them to continue", text)
        self.assertIn("formatSharePublishFailure", text)
        self.assertIn("throwSharePublishError", text)
        self.assertIn("prepareInProgress", text)
        self.assertIn("runShareCancelCleanup", text)
        self.assertIn("dismissShareOverlay", text)
        close_block = text.split("function closeOverlay()", 1)[1].split("function showPreflightState", 1)[0]
        self.assertIn("dismissShareOverlay();", close_block)
        self.assertNotIn("await cancelSharePublish", close_block)
        self.assertNotIn("await cleanupShareSession", close_block)

    def test_utilities_menu_has_manage_links_below_get_link(self):
        with open("static/fragments/utilitiesMenu.html", encoding="utf-8") as handle:
            text = handle.read()
        get_idx = text.index('id="getShareLinkBtn"')
        manage_idx = text.index('id="manageShareLinksBtn"')
        self.assertLess(get_idx, manage_idx)
        self.assertIn('data-cap="shareLink"', text.split("manageShareLinksBtn", 1)[0])


if __name__ == "__main__":
    unittest.main()
