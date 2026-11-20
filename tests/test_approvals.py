"""The code the reader agreed to run (`backend/approvals.py`)."""

from __future__ import annotations

from PySide6.QtCore import QSettings

import pytest

from backend.approvals import MAX_APPROVALS, SETTINGS_KEY, CodeApprovals, code_digest


@pytest.fixture
def settings(tmp_path):
    return QSettings(str(tmp_path / "edi.ini"), QSettings.Format.IniFormat)


def test_the_digest_covers_the_shebang_and_the_source():
    base = code_digest("#!sh", "echo 1")
    assert code_digest("#!sh", "echo 1") == base
    assert code_digest("#!bash", "echo 1") != base
    assert code_digest("#!sh", "echo 2") != base
    # The separator keeps "#!sh e" + "cho" apart from "#!sh" + " echo".
    assert code_digest("#!sh e", "cho") != code_digest("#!sh", " echo")


def test_approved_code_survives_a_restart(settings):
    digest = code_digest("#!sh", "echo 1")
    CodeApprovals(settings).approve(digest)
    assert CodeApprovals(settings).is_approved("", digest)


def test_a_trusted_document_lasts_until_quit(settings):
    approvals = CodeApprovals(settings)
    approvals.trust_until_quit("/a.md")
    assert approvals.is_approved("/a.md", code_digest("#!sh", "anything"))
    assert not approvals.is_approved("/b.md", code_digest("#!sh", "anything"))
    assert not CodeApprovals(settings).is_approved("/a.md", code_digest("#!sh", "anything"))


def test_no_document_is_never_trusted(settings):
    approvals = CodeApprovals(settings)
    approvals.trust_until_quit("")
    assert not approvals.is_approved("", code_digest("#!sh", "x"))


def test_the_oldest_approvals_fall_off(settings):
    approvals = CodeApprovals(settings)
    digests = [code_digest("#!sh", f"echo {index}") for index in range(MAX_APPROVALS + 1)]
    for digest in digests:
        approvals.approve(digest)
    again = CodeApprovals(settings)
    assert not again.is_approved("", digests[0])
    assert again.is_approved("", digests[-1])
    assert again.count() == MAX_APPROVALS


def test_forget_takes_back_everything(settings):
    approvals = CodeApprovals(settings)
    approvals.approve(code_digest("#!sh", "echo 1"))
    approvals.trust_until_quit("/a.md")
    approvals.forget()
    assert approvals.count() == 0
    assert settings.value(SETTINGS_KEY) is None


def test_a_hand_edited_store_keeps_only_digests(settings):
    good = code_digest("#!sh", "echo 1")
    settings.setValue(SETTINGS_KEY, [good, "not a digest"])
    assert CodeApprovals(settings).count() == 1
