/**
 * videoCreation service — 渲染端对 window.electron.video 的薄封装。
 *
 * 「多平台视频创作」功能的所有重活(拆句、TTS 配音、下载/裁剪素材、
 * Ken Burns 运镜、ffmpeg 合成)都在主进程做,本文件只暴露给 React 组件
 * 调用的异步方法 + 进度订阅。
 *
 * 一期(路线 A)只做本地出片:参考文案 → 配音 → 参考图/在线素材库画面 →
 * 字幕 → 合成 mp4 存本地。AI 仿写文案、Seedance 纯 AI 原创、自动上传到
 * 抖音/小红书/币安都是后续里程碑,这里先留接口。
 */

export type VideoAspect = '9:16' | '16:9' | '1:1';

export type VideoPublishTarget = 'local' | 'douyin' | 'xhs' | 'binance';

export interface VideoCreationInput {
  /** 人设 —— 影响 AI 文案口吻(一期文案靠粘贴,这里先收着备用)。 */
  persona: string;
  /** 赛道 / 细分领域。 */
  track: string;
  /** 关键词 —— 决定在线素材库搜什么空镜。 */
  keywords: string[];
  /** 参考文案 —— 一期直接当口播稿用(逐句拆分镜)。 */
  script: string;
  /** 用户上传的参考图本地绝对路径(0-3 张,优先用于画面)。 */
  referenceImages: string[];
  /** 画幅,默认竖屏 9:16。 */
  aspect: VideoAspect;
  /** 发布去向。一期只支持 'local';其余为占位。 */
  publishTarget: VideoPublishTarget;
  /** 可选背景音乐本地路径。空 = 不加 BGM。 */
  bgmPath?: string;
}

export interface VideoCreationProgressStep {
  key: string;
  label: string;
  status: 'waiting' | 'running' | 'done' | 'error';
}

export interface VideoCreationProgress {
  jobId: string;
  status: 'running' | 'done' | 'error';
  steps: VideoCreationProgressStep[];
  message?: string;
  /** 出片后的本地绝对路径。 */
  outputPath?: string;
  error?: string;
}

export interface VideoCreationResult {
  ok: boolean;
  outputPath?: string;
  error?: string;
}

type ProgressHandler = (p: VideoCreationProgress) => void;

class VideoCreationService {
  private get api(): any {
    return (window as any).electron?.video;
  }

  /** 主进程是否已挂上 video IPC(没挂时 UI 给出友好提示而不是崩)。 */
  get available(): boolean {
    return !!this.api;
  }

  /** 弹系统文件选择框选参考图,返回绝对路径数组(最多 max 张)。 */
  async pickReferenceImages(max = 3): Promise<string[]> {
    if (!this.api?.pickImages) return [];
    try {
      const paths = await this.api.pickImages(max);
      return Array.isArray(paths) ? paths.slice(0, max) : [];
    } catch {
      return [];
    }
  }

  /** 把本地图片读成 data: URL,给参考图缩略图预览用(渲染端 CSP 下加载不了 file://)。 */
  async readImageDataUrl(path: string): Promise<string> {
    if (!this.api?.readImageDataUrl) return '';
    try {
      const url = await this.api.readImageDataUrl(path);
      return typeof url === 'string' ? url : '';
    } catch {
      return '';
    }
  }

  /** 弹系统文件选择框选一首背景音乐,返回绝对路径('' = 取消)。 */
  async pickBgm(): Promise<string> {
    if (!this.api?.pickAudio) return '';
    try {
      const p = await this.api.pickAudio();
      return typeof p === 'string' ? p : '';
    } catch {
      return '';
    }
  }

  /** 在系统文件管理器里定位某个文件。 */
  async revealInFolder(path: string): Promise<void> {
    try {
      await this.api?.revealInFolder?.(path);
    } catch {}
  }

  /** 用系统默认播放器打开成片。 */
  async openFile(path: string): Promise<void> {
    try {
      await this.api?.openFile?.(path);
    } catch {}
  }

  /**
   * 启动一次本地出片。onProgress 会在拆句/配音/素材/合成各阶段回调。
   * 返回最终结果(成功带 outputPath)。
   */
  async generate(
    input: VideoCreationInput,
    onProgress?: ProgressHandler,
  ): Promise<VideoCreationResult> {
    if (!this.api?.generate) {
      return { ok: false, error: '视频生成模块尚未就绪(主进程未挂载 video IPC)' };
    }
    let unsub: (() => void) | undefined;
    try {
      if (onProgress && this.api.onProgress) {
        unsub = this.api.onProgress((p: VideoCreationProgress) => onProgress(p));
      }
      const res: VideoCreationResult = await this.api.generate(input);
      return res;
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 200) };
    } finally {
      if (unsub) {
        try { unsub(); } catch {}
      }
    }
  }
}

export const videoCreationService = new VideoCreationService();
