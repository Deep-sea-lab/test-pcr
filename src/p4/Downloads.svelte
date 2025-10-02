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

</script>

<style>
  .alternative {
    font-size: smaller;
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
  </div>
</Section>
