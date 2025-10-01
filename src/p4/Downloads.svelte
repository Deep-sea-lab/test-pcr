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
  let workflowUrl = null;

  // When the component is mounted and we have a blob, check if it's a Cordova Android zip
  // and create a workflow file if needed
  import {onMount} from 'svelte';
  onMount(async () => {
    if (blob && name && name.endsWith('.zip') && blob.type === 'application/zip') {
      try {
        // Check if this is a Cordova Android zip by looking for specific files
        const JSZip = await getJSZip();
        const zip = await JSZip.loadAsync(blob);
        
        // Check if this is a Cordova Android project
        if (zip.file('config.xml') && zip.file('package.json')) {
          // Create a blob with the workflow content
          const workflowContent = `name: Cordova Build

on:
  push:
    branches:
      - main
  pull_request:
    branches:
      - main
      
permissions:
  # required to modify releases
  contents: write

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      # Check out the repository code
      - name: Checkout code
        uses: actions/checkout@v4

      # Set up Node.js
      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      # Set up Java 17
      - name: Set up JDK 17
        uses: actions/setup-java@v4
        with:
          java-version: '17'
          distribution: 'adopt'

      # Set up Android SDK and Build Tools
      - name: Set up Android SDK
        uses: android-actions/setup-android@v3
        with:
          cmdline-tools-version: 'latest'

      # Install Android Build Tools
      - name: Install Android Build Tools
        run: |
          sdkmanager "build-tools;30.0.3" "platform-tools" "platforms;android-33"
        env:
          ANDROID_HOME: ${{ env.ANDROID_HOME }}
          ANDROID_SDK_ROOT: ${{ env.ANDROID_HOME }}

      # Set up Gradle
      - name: Set up Gradle
        uses: gradle/actions/setup-gradle@v4
        with:
          gradle-version: '7.6.5' # Specify a stable Gradle version compatible with Android builds

      # Install Cordova globally
      - name: Install Cordova
        run: npm install -g cordova
        
      # Find and unzip the project's zip file
      - name: Unzip project
        run: |
          ZIP_FILE=$(find . -maxdepth 1 -name "*.zip" -type f)
          if [ -z "$ZIP_FILE" ]; then
            echo "No zip file found"
            exit 1
          fi
          unzip "$ZIP_FILE" -d project
          rm "$ZIP_FILE"

      # Navigate to unzipped project directory and run npm install
      - name: Install dependencies
        run: |
          cd project
          npm install

      # Run npm build
      - name: Build project
        run: |
          cd project
          npm run build
        env:
          ANDROID_HOME: ${{ env.ANDROID_HOME }}
          ANDROID_SDK_ROOT: ${{ env.ANDROID_HOME }}

      - name: Create ZIP file
        run: |
          zip -r project.zip .  # 打包整个项目为 ZIP 文件

      - name: Upload ZIP file
        uses: actions/upload-artifact@v4
        with:
          name: project-zip
          path: project.zip

      - name: Upload artifacts to tag
        uses: xresloader/upload-to-github-release@2bcae85344d41e21f7fc4c47fa2ed68223afdb49
        with:
          file: ./project/platforms/android/app/build/outputs/apk/debug/app-debug.apk
          draft: false
          tag_name: "deep-sea-build"`;
          
          const workflowBlob = new Blob([workflowContent], {type: 'text/plain'});
          workflowUrl = URL.createObjectURL(workflowBlob);
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
    {#if workflowUrl}
      <p>
        <a href={workflowUrl} download="main.yml">
          Download main.yml
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
