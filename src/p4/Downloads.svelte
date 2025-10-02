<script>
  import Section from './Section.svelte';
  import {_} from '../locales';
  import {getJSZip} from '../packager/packager';
  import downloadURL from './download-url';
  import {isChromeOS} from './environment';
  import {onMount} from 'svelte';

  export let name;
  export let url;
  export let blob;

  let workaroundInProgress;
  let txtUrl = null;

  // 新增：标记是否为 Cordova Android 包（在 onMount 检测）
  let isCordovaAndroid = false;

  // 新增：GitHub 上传相关状态与输入
  let githubUser = '';
  let githubToken = '';
  let uploadInProgress = false;
  let uploadError = '';
  let uploadedFileUrl = '';
  let createdRepoUrl = '';

  // 当组件挂载且有 blob 时，检查是否为 Cordova Android zip 并在需要时创建 hello.txt
  onMount(async () => {
    if (blob && name && name.endsWith('.zip') && blob.type === 'application/zip') {
      try {
        const JSZip = await getJSZip();
        const zip = await JSZip.loadAsync(blob);
        
        // 检测 Cordova Android 项目（配置文件与 package.json 同时存在）
        if (zip.file('config.xml') && zip.file('package.json')) {
          isCordovaAndroid = true;
          // Create a blob with "hello" content
          const txtBlob = new Blob(['hello'], {type: 'text/plain'});
          txtUrl = URL.createObjectURL(txtBlob);
        }
      } catch (e) {
        console.warn('Could not analyze zip file:', e);
      }
    }
  });

  const useAlternativeDownloadToBypassChromeOSBugs = async () => {
    workaroundInProgress = true;

    try {
      const JSZip = await getJSZip();
      const zip = new JSZip();
      zip.file(name, blob);
      const zippedBlob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE'
      });
      const newFileName = name.replace(/\.html$/, '.zip');
  
      const blobURL = URL.createObjectURL(zippedBlob);
      downloadURL(newFileName, blobURL);
      URL.revokeObjectURL(blobURL);
    } catch (e) {
      console.error(e);
    }

    workaroundInProgress = false;
  };

  // 新增：将当前要下载的文件上传到临时 GitHub 仓库
  const uploadToGitHub = async () => {
    uploadError = '';
    uploadedFileUrl = '';
    createdRepoUrl = '';

    if (!githubUser || !githubToken) {
      uploadError = '请输入 GitHub 用户名和 Token';
      return;
    }
    if (!blob || !name) {
      uploadError = '没有可上传的文件';
      return;
    }

    uploadInProgress = true;
    try {
      // 生成一个唯一仓库名
      const rand = Math.random().toString(36).slice(2, 8);
      const repoName = `temp-packager-${Date.now().toString(36)}-${rand}`;

      // 创建仓库（私有）
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
      // 仓库页面
      createdRepoUrl = repoJson.html_url || `https://github.com/${githubUser}/${repoName}`;

      // 读取 blob 并转为 base64
      const arrayBuffer = await blob.arrayBuffer();
      // 将 ArrayBuffer 转为 base64（分块以避免堆栈问题）
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
      }
      const base64 = btoa(binary);

      // 上传文件到仓库（contents API）
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
      uploadedFileUrl = (putJson && putJson.content && putJson.content.html_url) || `${createdRepoUrl}/blob/main/${encodeURIComponent(name)}`;
    } catch (e) {
      console.error('GitHub upload error', e);
      uploadError = e.message || '上传失败';
    } finally {
      uploadInProgress = false;
    }
  };
</script>

<style>
  .alternative {
    font-size: smaller;
  }
  .github-uploader {
    margin-top: 0.5rem;
    border: 1px dashed #ccc;
    padding: 0.5rem;
    border-radius: 4px;
  }
  .github-uploader input {
    width: 100%;
    box-sizing: border-box;
    margin: 0.25rem 0;
  }
  .github-uploader button {
    margin-top: 0.25rem;
  }
  .upload-status {
    margin-top: 0.5rem;
    font-size: 0.9rem;
  }
</style>

<Section center>
  <div>
    <p>
      <a href={url} download={name}>
        {$_('downloads.link')
          .replace('{size}', `${(blob.size / 1000 / 1000).toFixed(2)}MB`)
          .replace('{filename}', name)}
      </a>
    </p>
    {#if txtUrl}
      <p>
        <a href={txtUrl} download="hello.txt">
          Download hello.txt
        </a>
      </p>
    {/if}

    {#if isChromeOS && name.endsWith('.html')}
      <p class="alternative">
        <button
          on:click={useAlternativeDownloadToBypassChromeOSBugs}
          disabled={workaroundInProgress}
        >
          {$_('downloads.useWorkaround')}
        </button>
      </p>
    {/if}

    <!-- 新增：仅当检测为 Cordova Android 时显示 GitHub 上传 UI -->
    {#if isCordovaAndroid}
      <div class="github-uploader">
        <div>
          <label for="github-user">GitHub 用户名</label>
          <input id="github-user" type="text" bind:value={githubUser} placeholder="your-github-username" />
        </div>
        <div>
          <label for="github-token">Personal access token (需要 repo 权限)</label>
          <input id="github-token" type="password" bind:value={githubToken} placeholder="ghp_xxx..." />
        </div>
        <div>
          <button on:click={uploadToGitHub} disabled={uploadInProgress}>
            {#if uploadInProgress}
              Uploading...
            {:else}
              Upload to GitHub (临时仓库)
            {/if}
          </button>
        </div>

        <div class="upload-status">
          {#if createdRepoUrl}
            <div>仓库已创建: <a href={createdRepoUrl} target="_blank" rel="noopener">{createdRepoUrl}</a></div>
          {/if}
          {#if uploadedFileUrl}
            <div>文件已上传: <a href={uploadedFileUrl} target="_blank" rel="noopener">{uploadedFileUrl}</a></div>
          {/if}
          {#if uploadError}
            <div style="color:tomato">错误: {uploadError}</div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</Section>
