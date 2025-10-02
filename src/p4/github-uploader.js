export async function uploadAndBuildFromTemplate({
  blob,
  name,
  githubUser,
  githubToken,
  templateOwner = 'Deep-sea-lab',
  templateRepo = '02packager-template',
  workflowId = 'main.yml',
  autoDelete = true,
  pollIntervalMs = 10000,
  pollMaxAttempts = 60
}) {
  if (!githubUser || !githubToken) throw new Error('Missing GitHub username or token');
  if (!blob || !name) throw new Error('Missing blob or filename');

  const apiBase = 'https://api.github.com';

  // 1) Generate repository from template
  const rand = Math.random().toString(36).slice(2, 8);
  const repoName = `temp-packager-${Date.now().toString(36)}-${rand}`;

  const genUrl = `${apiBase}/repos/${templateOwner}/${templateRepo}/generate`;
  const genResp = await fetch(genUrl, {
    method: 'POST',
    headers: {
      Authorization: `token ${githubToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json'
    },
    body: JSON.stringify({ name: repoName, owner: githubUser, private: true })
  });
  if (!genResp.ok) {
    const err = await genResp.text();
    throw new Error(`生成仓库失败: ${genResp.status} ${err}`);
  }
  const genJson = await genResp.json();
  const createdRepoUrl = genJson.html_url || `https://github.com/${githubUser}/${repoName}`;

  // 2) Upload the packed file to the repo via contents API
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
  }
  const base64 = btoa(binary);

  const putUrl = `${apiBase}/repos/${githubUser}/${repoName}/contents/${encodeURIComponent(name)}`;
  const putResp = await fetch(putUrl, {
    method: 'PUT',
    headers: {
      Authorization: `token ${githubToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json'
    },
    body: JSON.stringify({ message: `Upload ${name} via packager`, content: base64 })
  });
  if (!putResp.ok) {
    const err = await putResp.text();
    throw new Error(`上传文件失败: ${putResp.status} ${err}`);
  }

  // 3) Trigger workflow dispatch
  const dispatchUrl = `${apiBase}/repos/${githubUser}/${repoName}/actions/workflows/${workflowId}/dispatches`;
  const dispatchResp = await fetch(dispatchUrl, {
    method: 'POST',
    headers: {
      Authorization: `token ${githubToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json'
    },
    body: JSON.stringify({ ref: 'main' })
  });
  if (![204,201,202].includes(dispatchResp.status)) {
    const err = await dispatchResp.text();
    throw new Error(`触发 workflow 失败: ${dispatchResp.status} ${err}`);
  }

  // 4) Poll for latest run and wait for conclusion
  const runsUrlBase = `${apiBase}/repos/${githubUser}/${repoName}/actions/runs`;
  let runId = null;
  let attempt = 0;
  let runObj = null;
  while (attempt < pollMaxAttempts) {
    attempt++;
    await new Promise(r => setTimeout(r, attempt === 1 ? 2000 : pollIntervalMs));
    const runsResp = await fetch(`${runsUrlBase}?per_page=1`, {
      headers: { Authorization: `token ${githubToken}`, Accept: 'application/vnd.github+json' }
    });
    if (!runsResp.ok) {
      // try again
      continue;
    }
    const runsJson = await runsResp.json();
    const wr = runsJson.workflow_runs && runsJson.workflow_runs[0];
    if (!wr) continue;
    runId = wr.id;
    // fetch run details
    const runResp = await fetch(`${apiBase}/repos/${githubUser}/${repoName}/actions/runs/${runId}`, {
      headers: { Authorization: `token ${githubToken}`, Accept: 'application/vnd.github+json' }
    });
    if (!runResp.ok) continue;
    runObj = await runResp.json();
    const status = runObj.status;
    const conclusion = runObj.conclusion;
    if (conclusion === 'success') break;
    if (conclusion && (conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out')) {
      throw new Error(`Workflow finished with conclusion: ${conclusion}`);
    }
    // otherwise keep polling
  }
  if (!runObj || runObj.conclusion !== 'success') {
    throw new Error('Workflow did not complete successfully in time');
  }

  // 5) Get latest release for the repo
  const releaseResp = await fetch(`${apiBase}/repos/${githubUser}/${repoName}/releases/latest`, {
    headers: { Authorization: `token ${githubToken}`, Accept: 'application/vnd.github+json' }
  });
  if (!releaseResp.ok) {
    const err = await releaseResp.text();
    throw new Error(`获取 release 失败: ${releaseResp.status} ${err}`);
  }
  const releaseJson = await releaseResp.json();
  if (!releaseJson.assets || releaseJson.assets.length === 0) {
    throw new Error('未找到 release 资产');
  }
  const asset = releaseJson.assets[0];
  const downloadUrl = asset.browser_download_url;

  // 6) Attempt to download asset (authorized) and trigger client download, then optionally delete repo
  // Fetch the asset with Authorization to handle private repos
  const assetResp = await fetch(downloadUrl, {
    headers: { Authorization: `token ${githubToken}` },
  });
  if (!assetResp.ok) {
    const err = await assetResp.text();
    throw new Error(`下载资产失败: ${assetResp.status} ${err}`);
  }
  const assetBlob = await assetResp.blob();

  // Trigger browser download
  const blobUrl = URL.createObjectURL(assetBlob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = asset.name || name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);

  // Optionally delete the repo
  if (autoDelete) {
    const delResp = await fetch(`${apiBase}/repos/${githubUser}/${repoName}`, {
      method: 'DELETE',
      headers: { Authorization: `token ${githubToken}`, Accept: 'application/vnd.github+json' }
    });
    if (!delResp.ok) {
      // Not fatal: log and continue
      console.warn('删除临时仓库失败:', await delResp.text());
    }
  }

  // Return links for UI
  return {
    createdRepoUrl,
    releaseUrl: releaseJson.html_url || `${createdRepoUrl}/releases/latest`,
    assetName: asset.name
  };
}
