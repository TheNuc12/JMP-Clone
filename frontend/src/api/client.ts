import type { AnalysisResult, AnalyzeRequest, DataTablePayload, SampleInfo } from './types'

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch {
    throw new ApiError('Cannot reach the Sift server. Is the backend running?')
  }
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`
    try {
      const body = await response.json()
      if (typeof body.detail === 'string') detail = body.detail
      else if (body.detail) detail = JSON.stringify(body.detail)
    } catch {
      // keep the status text
    }
    throw new ApiError(detail)
  }
  return response.json() as Promise<T>
}

export const api = {
  samples: () => request<SampleInfo[]>('/api/samples'),

  sample: (id: string) => request<DataTablePayload>(`/api/samples/${encodeURIComponent(id)}`),

  upload: (file: File) => {
    const body = new FormData()
    body.append('file', file)
    return request<DataTablePayload>('/api/upload', { method: 'POST', body })
  },

  analyze: (req: AnalyzeRequest, signal?: AbortSignal) =>
    request<AnalysisResult>('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal,
    }),
}
