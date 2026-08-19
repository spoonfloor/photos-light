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
        self.assertIn("generate_access_token()", prepare_block)
        self.assertIn("'access_token': access_token", prepare_block)

    def test_share_flow_passes_access_token_on_publish(self):
        with open("static/js/shareFlow.js", encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("accessToken: prepared.access_token", text)
        self.assertIn("access_token: session.accessToken", text)

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
        self.assertIn("setShareButtonDisabled(true)", text)
        self.assertIn("shareOverlayDoneBtn", text)

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
        self.assertIn("_delete_storage_paths", delete_source)
        self.assertIn("_list_all_storage_files", inspect.getsource(share_albums))
        self.assertIn('"prefixes"', inspect.getsource(share_albums._delete_storage_paths))
        self.assertIn('"/rest/v1/albums?id=eq.', delete_source)
        self.assertIn("_delete_storage_paths", delete_source.split('"/rest/v1/albums?id=eq.', 1)[1])
        self.assertNotIn("_list_storage_paths", delete_source)
        self.assertIn("thumb_path", delete_source)
        self.assertNotIn("revoked_at", delete_source)

    def test_app_exposes_share_album_routes(self):
        with open("app.py", encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("def share_albums_list():", text)
        self.assertIn("def share_album_delete(album_id):", text)
        self.assertIn("list_share_albums()", text)
        self.assertIn("delete_share_album(album_key)", text)

    def test_share_flow_exposes_manage_links_entry(self):
        with open("static/js/shareFlow.js", encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("openManageLinks", text)
        self.assertIn("/api/share/albums", text)
        self.assertIn("shareManageOverlay.html", text)
        self.assertIn("manageShareLinksBtn", text)
        manage_block = text.split("const manageEnabled =", 1)[1].split(";", 1)[0]
        self.assertNotIn("hasDatabase", manage_block)
        self.assertIn("shareManageTitle", text)
        self.assertIn("Manage links (${manageAlbums.length})", text)
        self.assertIn("preloadManageOverlay", text)
        self.assertIn("background: true", text)

    def test_utilities_menu_has_manage_links_below_get_link(self):
        with open("static/fragments/utilitiesMenu.html", encoding="utf-8") as handle:
            text = handle.read()
        get_idx = text.index('id="getShareLinkBtn"')
        manage_idx = text.index('id="manageShareLinksBtn"')
        self.assertLess(get_idx, manage_idx)
        self.assertIn('data-cap="shareLink"', text.split("manageShareLinksBtn", 1)[0])


if __name__ == "__main__":
    unittest.main()
