from __future__ import annotations

import json
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ROLES_ROOT = ROOT / "roles"


def ensure_dir(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    path.mkdir(parents=True, exist_ok=True)


def move_if_needed(src: Path, dst: Path) -> None:
    if src.exists() and not dst.exists():
        ensure_dir(dst.parent)
        shutil.move(str(src), str(dst))


def copy_if_missing(src: Path, dst: Path) -> None:
    if not src.exists() or dst.exists():
        return
    ensure_dir(dst.parent)
    if src.is_dir():
        shutil.copytree(src, dst)
    else:
        shutil.copy2(src, dst)


def merge_move_dir(src: Path, dst: Path) -> None:
    if not src.exists():
        return
    ensure_dir(dst)
    for child in src.iterdir():
        target = dst / child.name
        if child.is_dir():
            if target.exists():
                merge_move_dir(child, target)
                child.rmdir()
            else:
                shutil.move(str(child), str(target))
        else:
            if target.exists():
                child.unlink()
            else:
                shutil.move(str(child), str(target))
    if src.exists():
        try:
            src.rmdir()
        except OSError:
            pass


def write_json(path: Path, data: object) -> None:
    ensure_dir(path.parent)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def rewrite_action_video_paths(action_dir: Path) -> None:
    actions_path = action_dir / "actions.json"
    videos_dir = action_dir / "videos"
    if not actions_path.exists() or not videos_dir.exists():
        return
    try:
      items = json.loads(actions_path.read_text(encoding="utf-8"))
    except Exception:
      return
    if not isinstance(items, list):
        return
    changed = False
    for item in items:
        if not isinstance(item, dict):
            continue
        item_id = str(item.get("id") or "").strip()
        if not item_id:
            continue
        target_video = videos_dir / f"{item_id}.mp4"
        if target_video.exists():
            next_path = str(target_video)
            if item.get("videoPath") != next_path:
                item["videoPath"] = next_path
                changed = True
    if changed:
        write_json(actions_path, items)


def main() -> None:
    ensure_dir(ROLES_ROOT)

    roles = {
        "default": {"label": "默认角色", "legacy_state_dir": ROOT / "state"},
        "sy": {"label": "沈言", "legacy_state_dir": ROOT / "state_sy"},
        "zm": {"label": "米娅", "legacy_state_dir": ROOT / "state_zm"},
    }

    for role_id, meta in roles.items():
        role_root = ROLES_ROOT / f"role_{role_id}"
        ensure_dir(role_root)
        state_dir = role_root / "state"
        move_if_needed(meta["legacy_state_dir"], state_dir)
        ensure_dir(state_dir)
        ensure_dir(role_root / "backgrounds" / "default")

    for role_id in ("default", "zm"):
        role_root = ROLES_ROOT / f"role_{role_id}"
        embedded_action_dir = role_root / "state" / "action"
        role_action_dir = role_root / "action" / "default"
        merge_move_dir(embedded_action_dir, role_action_dir)

    for role_id in roles:
        ensure_dir(ROLES_ROOT / f"role_{role_id}" / "action" / "default")
        rewrite_action_video_paths(ROLES_ROOT / f"role_{role_id}" / "action" / "default")

    default_action_dir = ROLES_ROOT / "role_default" / "action" / "default"
    sy_action_dir = ROLES_ROOT / "role_sy" / "action" / "default"
    copy_if_missing(default_action_dir / "actions.json", sy_action_dir / "actions.json")
    copy_if_missing(default_action_dir / "videos", sy_action_dir / "videos")

    role_catalog = {
        "roles": [
            {"roleDir": "roles/role_default"},
            {"roleDir": "roles/role_sy"},
            {"roleDir": "roles/role_mia"},
        ]
    }
    write_json(ROLES_ROOT / "roles.json", role_catalog)

    for role_id, meta in roles.items():
        role_root = ROLES_ROOT / f"role_{role_id}"
        role_config = {
            "id": role_id,
            "label": meta["label"],
            "stateDir": "state",
            "styles": [
                {
                    "id": "default",
                    "label": "默认风格",
                    "actionDir": "action/default",
                    "backgroundsDir": "backgrounds/default",
                }
            ],
        }
        write_json(role_root / "role.json", role_config)

    print("Role layout migration complete.")


if __name__ == "__main__":
    main()
