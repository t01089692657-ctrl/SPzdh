"""OpenMontage 桥接脚本（可选增强）。

平台默认使用内置 ffmpeg 剪辑引擎；当服务器安装了 OpenMontage 且
config.json 里 editor.preferOpenMontage 为 true 时，剪辑任务会走本脚本。
"""
import json
import os
import subprocess
import sys
from pathlib import Path

IS_WINDOWS = os.name == "nt"
EXE = ".exe" if IS_WINDOWS else ""


def probe_duration(ffprobe, path):
    try:
        proc = subprocess.run(
            [
                str(ffprobe),
                "-v",
                "quiet",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        return float((proc.stdout or "0").strip() or 0)
    except Exception:
        return 0.0


def single_clip_export(ffmpeg, clip, output, resolution):
    width, height = resolution.split("x")
    subprocess.run(
        [
            str(ffmpeg),
            "-y",
            "-i",
            str(clip),
            "-vf",
            f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2",
            "-r",
            "30",
            "-c:v",
            "libx264",
            "-crf",
            "22",
            "-preset",
            "medium",
            "-c:a",
            "aac",
            "-pix_fmt",
            "yuv420p",
            str(output),
        ],
        check=True,
    )


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Usage: python openmontage_bridge.py plan.json")

    plan_path = Path(sys.argv[1]).resolve()
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    openmontage_root = Path(plan["openmontage_root"]).resolve()
    local_bin = openmontage_root / ".local-bin"
    os.environ["PATH"] = str(local_bin) + os.pathsep + os.environ.get("PATH", "")
    sys.path.insert(0, str(openmontage_root))

    ffmpeg = local_bin / f"ffmpeg{EXE}"
    ffprobe = local_bin / f"ffprobe{EXE}"
    clips = [str(Path(item).resolve()) for item in plan.get("clips", [])]
    output = Path(plan["output_path"]).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    if not clips:
        raise SystemExit("No clips provided")

    reference = plan.get("reference")
    reference_duration = probe_duration(ffprobe, reference) if reference else 0
    transition = plan.get("transition") or ("crossfade" if reference_duration >= 8 else "cut")
    transition_duration = float(plan.get("transition_duration") or 0.35)
    resolution = plan.get("target_resolution") or "1080x1920"

    if len(clips) == 1:
        single_clip_export(ffmpeg, clips[0], output, resolution)
        result = {
            "success": True,
            "data": {
                "operation": "single_clip_export",
                "output": str(output),
                "reference_duration": reference_duration,
            },
            "artifacts": [str(output)],
        }
    else:
        from tools.video.video_stitch import VideoStitch

        tool = VideoStitch()
        tool_result = tool.execute(
            {
                "operation": "stitch",
                "clips": clips,
                "output_path": str(output),
                "transition": transition,
                "transition_duration": transition_duration,
                "auto_normalize": True,
                "target_resolution": resolution,
                "target_fps": int(plan.get("target_fps") or 30),
                "codec": "libx264",
                "crf": int(plan.get("crf") or 22),
                "preset": plan.get("preset") or "medium",
            }
        )
        result = {
            "success": bool(tool_result.success),
            "error": tool_result.error,
            "data": tool_result.data,
            "artifacts": tool_result.artifacts,
        }

    if not result.get("success"):
        raise SystemExit(result.get("error") or "OpenMontage edit failed")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
