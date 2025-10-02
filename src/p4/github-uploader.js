export async function uploadBlobToTempRepo({blob, name, githubUser, githubToken}) {
  if (!githubUser || !githubToken) throw new Error('Missing GitHub username or token');
  if (!blob || !name) throw new Error('Missing blob or filename');

  // Create a unique repo name
  const rand = Math.random().toString(36).slice(2, 8);
  const repoName = `temp-packager-${Date.now().toString(36)}-${rand}`;

  // Create repo
  const createRepoResp = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      'Authorization': `token ${githubToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github+json'
    },
    body: JSON.stringify({
      name: repoName,
      private: true,
      auto_init: false
    })
  });

  if (!createRepoResp.ok) {
    const errText = await createRepoResp.text();
    throw new Error(`创建仓库失败: ${createRepoResp.status} ${errText}`);
  }

  const repoJson = await createRepoResp.json();
  const createdRepoUrl = repoJson.html_url;

  // Convert blob to base64
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
  }
  const base64 = btoa(binary);

  // Upload file
  const putUrl = `https://api.github.com/repos/${githubUser}/${repoName}/contents/${name}`;
  const putResp = await fetch(putUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `token ${githubToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github+json'
    },
    body: JSON.stringify({
      message: `Upload ${name} via packager`,
      content: base64,
    })
  });

  if (!putResp.ok) {
    const errText = await putResp.text();
    throw new Error(`上传文件失败: ${putResp.status} ${errText}`);
  }

  const putJson = await putResp.json();
  const uploadedFileUrl = (putJson && putJson.content && putJson.content.html_url) || `${createdRepoUrl}/blob/main/${encodeURIComponent(name)}`;

  return {
    createdRepoUrl,
    uploadedFileUrl
  };
}
