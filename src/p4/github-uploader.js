export async function uploadAndBuildFromTemplate(opts, progressCallback = null) {
  const {
    blob,
    name,
    githubUser,
    githubToken,
    templateOwner = 'Deep-sea-lab',
    templateRepo = '02packager-template',
    workflowId = 'main.yml',
    autoDelete = false,
    pollIntervalMs = 10000,
    pollMaxAttempts = 60
  } = opts || {};

  if (!githubUser || !githubToken) throw new Error('Missing GitHub username or token');
  if (!blob || !name) throw new Error('Missing blob or filename');

  const apiBase = 'https://api.github.com';

  // generate a unique temporary repo name
  const rand = Math.random().toString(36).slice(2, 8);
  const repoName = `packager-temp-${rand}`;

  const genUrl = `${apiBase}/repos/${templateOwner}/${templateRepo}/generate`;

  const progress = (msg) => {
    try {
      if (typeof progressCallback === 'function') progressCallback(msg);
    } catch (e) {
      // ignore
    }
  };
  // Try to generate repo from template. Some tokens/accounts may not be allowed to use template generation,
  // so fall back to creating a fresh repo via POST /user/repos (auto_init: true) if generate fails.
  progress('尝试使用模板生成临时仓库...');
  const genResp = await fetch(genUrl, {
    method: 'POST',
    headers: {
      Authorization: `token ${githubToken}`,
      'Content-Type': 'application/json',
      // older previews used "baptiste-preview" but generic json is usually accepted; include both as Accept
      Accept: 'application/vnd.github.baptiste-preview+json, application/vnd.github+json'
    },
    body: JSON.stringify({ name: repoName, owner: githubUser, private: false })
  });

  let createdRepoUrl;
  if (genResp.ok) {
    const genJson = await genResp.json();
    createdRepoUrl = genJson.html_url || `https://github.com/${githubUser}/${repoName}`;
    progress(`仓库已从模板生成: ${createdRepoUrl}`);
  } else {
    // Fallback: create a repo under the authenticated user (POST /user/repos)
    progress('模板生成失败，尝试在账户下创建临时仓库...');
    const fallbackResp = await fetch(`${apiBase}/user/repos`, {
      method: 'POST',
      headers: {
        Authorization: `token ${githubToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json'
      },
      body: JSON.stringify({ name: repoName, private: false, auto_init: true, description: 'Temp repo created by packager' })
    });
    if (!fallbackResp.ok) {
      const err = await genResp.text();
      const fbErr = await fallbackResp.text();
      throw new Error(`无法生成或创建仓库 (generate status: ${genResp.status} / fallback status: ${fallbackResp.status}). 生成错误: ${err}; 创建错误: ${fbErr}`);
    }
    const fbJson = await fallbackResp.json();
    createdRepoUrl = fbJson.html_url || `https://github.com/${githubUser}/${repoName}`;
    // If the source "template" repo isn't an actual GitHub template, copy its contents into the new repo
    async function copyTemplateContents() {
      const headers = { Authorization: `token ${githubToken}`, Accept: 'application/vnd.github+json' };

      // Determine default branch of template repo
      let defaultBranch = 'main';
      try {
        const infoResp = await fetch(`${apiBase}/repos/${templateOwner}/${templateRepo}`, { headers });
        if (infoResp.ok) {
          const infoJson = await infoResp.json();
          if (infoJson.default_branch) defaultBranch = infoJson.default_branch;
        }
      } catch (e) {
        console.warn('无法获取模板仓库信息，使用默认分支 main', e);
      }

  // Get the tree of the template repo recursively
      const treeResp = await fetch(`${apiBase}/repos/${templateOwner}/${templateRepo}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`, { headers });
      if (!treeResp.ok) {
        console.warn('无法获取模板 tree，跳过复制:', await treeResp.text());
        return;
      }
      const treeJson = await treeResp.json();
      const blobs = (treeJson.tree || []).filter(i => i.type === 'blob');

      for (const b of blobs) {
        try {
          const blobResp = await fetch(`${apiBase}/repos/${templateOwner}/${templateRepo}/git/blobs/${b.sha}`, { headers });
          if (!blobResp.ok) {
            console.warn(`无法获取 blob ${b.path}:`, await blobResp.text());
            continue;
          }
          const blobJson = await blobResp.json();
          let contentBase64 = blobJson.content || '';
          // blob content may contain newlines
          contentBase64 = contentBase64.replace(/\n/g, '');

          // Upload to target repo via contents API
          const putResp = await fetch(`${apiBase}/repos/${githubUser}/${repoName}/contents/${encodeURIComponent(b.path)}`, {
            method: 'PUT',
            headers: { Authorization: `token ${githubToken}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github+json' },
            body: JSON.stringify({ message: `Add template file ${b.path}`, content: contentBase64 })
          });
          if (!putResp.ok) {
            console.warn(`上传模板文件失败 ${b.path}:`, await putResp.text());
          }
        } catch (err) {
          console.warn('复制模板文件出错:', err);
        }
      }
    }

    try {
      await copyTemplateContents();
      progress('模板内容已复制到新仓库');
    } catch (e) {
      console.warn('复制模板内容失败:', e);
    }
  }

  // 2) Upload the packed file to the repo via contents API
  progress(`开始上传打包文件 ${name} 到仓库 ${githubUser}/${repoName} ...`);
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
  progress('打包文件上传完成');

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
  progress('已触发 GitHub Actions workflow，开始轮询执行状态...');

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
  progress(`工作流状态: ${status} 结论: ${conclusion || 'pending'}`);
    if (conclusion === 'success') break;
    if (conclusion && (conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out')) {
      throw new Error(`Workflow finished with conclusion: ${conclusion}`);
    }
    // otherwise keep polling
  }
  if (!runObj || runObj.conclusion !== 'success') {
    throw new Error('Workflow did not complete successfully in time');
  }

  progress('工作流执行成功，尝试获取 Release 及其资产...');

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

  progress(`找到 release 资产: ${asset.name}`);

  // Do not auto-download asset in the browser. Return the asset download URL so the UI can present it to the user.
  const assetDownloadUrl = downloadUrl;

  // Optionally delete the repo only if explicitly requested (default: false)
  if (autoDelete) {
    const delResp = await fetch(`${apiBase}/repos/${githubUser}/${repoName}`, {
      method: 'DELETE',
      headers: { Authorization: `token ${githubToken}`, Accept: 'application/vnd.github+json' }
    });
    if (!delResp.ok) {
      console.warn('删除临时仓库失败:', await delResp.text());
    }
  }

  // Return links for UI
  return {
    createdRepoUrl,
    releaseUrl: releaseJson.html_url || `${createdRepoUrl}/releases/latest`,
    assetName: asset.name,
    assetDownloadUrl
  };
}
