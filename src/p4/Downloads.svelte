<script>
  import Section from './Section.svelte';
  import {_} from '../locales';
  import {getJSZip} from '../packager/packager';
  import downloadURL from './download-url';
  import {isChromeOS} from './environment';

  export let name;
  export let url;
  export let blob;

  let workaroundInProgress;
  let txtUrl = null;

  // When the component is mounted and we have a blob, check if it's a Cordova Android zip
  // and create a txt file with "hello" content if needed
  import {onMount} from 'svelte';
  onMount(async () => {
    if (blob && name && name.endsWith('.zip') && blob.type === 'application/zip') {
      try {
        // Check if this is a Cordova Android zip by looking for specific files
        const JSZip = await getJSZip();
        const zip = await JSZip.loadAsync(blob);
        
        // Check if this is a Cordova Android project
        if (zip.file('config.xml') && zip.file('package.json')) {
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
    // We've had a lot of bug reports about people on Chrome OS devices not being able to download
    // HTML files but being able to download zip files just fine. We're pretty sure that's not our
    // fault so we have to work around it (I want to blame whatever surveillance extensions
    // they're being forced to install).

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
