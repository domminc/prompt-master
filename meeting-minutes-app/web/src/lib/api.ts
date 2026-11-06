import type { CreateUploadRequest, CreateUploadResponse, ExportFormat, JobDto } from "../../../shared/types";

export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiClientError("서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.", 0);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* JSON 이 아닌 응답 */
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `요청에 실패했어요 (${res.status})`;
    throw new ApiClientError(msg, res.status);
  }
  return data as T;
}

export const api = {
  createUpload: (req: CreateUploadRequest) => request<CreateUploadResponse>("POST", "/api/uploads", req),
  markUploading: (id: string) => request<{ ok: true }>("POST", `/api/uploads/${id}/start`),
  complete: (id: string, fileKey: string) => request<JobDto>("POST", `/api/uploads/${id}/complete`, { fileKey }),
  getJob: (id: string) => request<JobDto>("GET", `/api/jobs/${id}`),
  retry: (id: string) => request<JobDto>("POST", `/api/jobs/${id}/retry`),
  remove: (id: string) => request<{ ok: true }>("DELETE", `/api/jobs/${id}`),
  exportUrl: (id: string, format: ExportFormat) => `/api/jobs/${id}/export?format=${format}`,
  mediaUrl: (id: string) => `/api/jobs/${id}/media`,
  async exportText(id: string, format: ExportFormat): Promise<string> {
    const res = await fetch(api.exportUrl(id, format));
    if (!res.ok) throw new ApiClientError("내용을 가져오지 못했어요.", res.status);
    return res.text();
  },
};

/** 진행률이 나오는 PUT 업로드 (fetch 는 업로드 진행률을 알 수 없어 XHR 사용) */
export function putBlob(url: string, blob: Blob, onProgress: (ratio: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "audio/mpeg");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      reject(
        new ApiClientError(
          xhr.status === 403
            ? "업로드 링크가 만료됐거나 권한이 없어요. 처음부터 다시 시도해 주세요."
            : `업로드에 실패했어요 (${xhr.status}).`,
          xhr.status,
        ),
      );
    };
    // R2 CORS 설정이 빠졌을 때도 여기로 온다
    xhr.onerror = () => reject(new ApiClientError("업로드 연결에 실패했어요. 네트워크를 확인하고 다시 시도해 주세요.", 0));
    xhr.onabort = () => reject(new ApiClientError("업로드를 취소했어요.", 0));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(blob);
  });
}
