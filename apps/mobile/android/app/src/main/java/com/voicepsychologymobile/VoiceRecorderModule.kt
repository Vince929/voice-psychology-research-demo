package com.voicepsychologymobile

import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import android.util.Base64
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

class VoiceRecorderModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  private var recorder: MediaRecorder? = null
  private var player: MediaPlayer? = null
  private var outputFile: File? = null

  override fun getName(): String = "VoiceRecorder"

  @ReactMethod
  fun start(demoUpload: Boolean, promise: Promise) {
    if (recorder != null) {
      promise.reject("RECORDER_ACTIVE", "当前已有录音正在进行。")
      return
    }

    val recordingsDir = File(reactContext.filesDir, "recordings").apply { mkdirs() }
    val audioFile = File(recordingsDir, "voice-${System.currentTimeMillis()}.m4a")
    val newRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(reactContext) else MediaRecorder()

    try {
      newRecorder.setAudioSource(MediaRecorder.AudioSource.MIC)
      newRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
      newRecorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
      newRecorder.setAudioSamplingRate(44_100)
      newRecorder.setAudioEncodingBitRate(if (demoUpload) 512_000 else 128_000)
      newRecorder.setOutputFile(audioFile.absolutePath)
      newRecorder.prepare()
      newRecorder.start()
      recorder = newRecorder
      outputFile = audioFile
      promise.resolve("file://${audioFile.absolutePath}")
    } catch (error: Exception) {
      newRecorder.release()
      audioFile.delete()
      promise.reject("RECORDING_START_FAILED", "无法开始录音，请检查麦克风权限后重试。", error)
    }
  }

  @ReactMethod
  fun getFileInfo(uri: String, promise: Promise) {
    val audioFile = File(uri.removePrefix("file://"))
    if (!audioFile.isFile) {
      promise.reject("AUDIO_FILE_MISSING", "本地录音文件不存在或已被删除。")
      return
    }
    val result = com.facebook.react.bridge.Arguments.createMap()
    result.putString("uri", "file://${audioFile.absolutePath}")
    result.putDouble("size", audioFile.length().toDouble())
    promise.resolve(result)
  }

  @ReactMethod
  fun readFileChunk(uri: String, offset: Double, length: Int, promise: Promise) {
    val audioFile = File(uri.removePrefix("file://"))
    if (!audioFile.isFile) {
      promise.reject("AUDIO_FILE_MISSING", "本地录音文件不存在或已被删除。")
      return
    }
    if (offset < 0 || length <= 0) {
      promise.reject("INVALID_FILE_RANGE", "读取录音文件的范围无效。")
      return
    }
    try {
      RandomAccessFile(audioFile, "r").use { file ->
        file.seek(offset.toLong())
        val buffer = ByteArray(length)
        val bytesRead = file.read(buffer)
        if (bytesRead <= 0) {
          promise.resolve("")
          return
        }
        promise.resolve(Base64.encodeToString(buffer.copyOf(bytesRead), Base64.NO_WRAP))
      }
    } catch (error: Exception) {
      promise.reject("AUDIO_FILE_READ_FAILED", "无法读取本地录音文件，请重新录音后再试。", error)
    }
  }

  @ReactMethod
  fun deleteFile(uri: String, promise: Promise) {
    val audioFile = File(uri.removePrefix("file://"))
    if (!audioFile.exists() || audioFile.delete()) {
      promise.resolve(null)
      return
    }
    promise.reject("AUDIO_FILE_DELETE_FAILED", "无法删除本地录音文件。")
  }

  @ReactMethod
  fun play(url: String, promise: Promise) {
    player?.release()
    player = null

    val settled = AtomicBoolean(false)

    if (url.startsWith("file://")) {
      playFromFile(url.removePrefix("file://"), promise, settled)
      return
    }

    // Notify JS that download is starting
    reactContext.emitDeviceEvent("VoiceRecorderDownloadStarted", null)

    // Remote URL: download to local cache (keyed by URL hash), then play from file.
    Thread {
      try {
        downloadAndPlay(url, promise, settled)
      } catch (error: Exception) {
        reactContext.emitDeviceEvent("VoiceRecorderDownloadEnded", null)
        if (settled.compareAndSet(false, true)) {
          promise.reject("AUDIO_DOWNLOAD_FAILED", "下载录音失败，请检查网络后重试。", error)
        }
      }
    }.start()
  }

  private fun downloadAndPlay(urlString: String, promise: Promise, settled: AtomicBoolean) {
    val playbackDir = File(reactContext.cacheDir, "playback").apply { mkdirs() }
    val cacheKey = sha256(urlString).take(16)
    val localFile = File(playbackDir, "audio-$cacheKey")

    // Reuse cache if the file already exists (non-empty).
    if (localFile.isFile() && localFile.length() > 0 && !settled.get()) {
      reactContext.emitDeviceEvent("VoiceRecorderDownloadEnded", null)
      playFromFile(localFile.absolutePath, promise, settled)
      return
    }

    val tmpFile = File(playbackDir, "tmp-$cacheKey-${System.currentTimeMillis()}")
    try {
      val connection = URL(urlString).openConnection() as HttpURLConnection
      connection.connectTimeout = 15_000
      connection.readTimeout = 30_000
      connection.connect()

      if (connection.responseCode != HttpURLConnection.HTTP_OK) {
        if (settled.compareAndSet(false, true)) {
          reactContext.emitDeviceEvent("VoiceRecorderDownloadEnded", null)
          promise.reject("AUDIO_DOWNLOAD_FAILED", "下载录音失败（HTTP ${connection.responseCode}），请稍后重试。")
        }
        connection.disconnect()
        return
      }

      connection.inputStream.use { input ->
        FileOutputStream(tmpFile).use { output ->
          input.copyTo(output)
        }
      }
      connection.disconnect()

      if (settled.get()) {
        tmpFile.delete()
        return
      }

      // Atomically replace the cache file.
      if (localFile.exists()) localFile.delete()
      tmpFile.renameTo(localFile)

      reactContext.emitDeviceEvent("VoiceRecorderDownloadEnded", null)
      playFromFile(localFile.absolutePath, promise, settled)
    } catch (error: Exception) {
      tmpFile.delete()
      throw error
    }
  }

  private fun playFromFile(filePath: String, promise: Promise, settled: AtomicBoolean) {
    val newPlayer = MediaPlayer()
    newPlayer.setOnPreparedListener {
      if (settled.compareAndSet(false, true)) {
        try {
          it.start()
          promise.resolve(null)
        } catch (error: Exception) {
          it.release()
          promise.reject("AUDIO_PLAYBACK_FAILED", "播放启动失败，请重试。", error)
        }
      } else {
        it.release()
      }
    }
    newPlayer.setOnCompletionListener { completedPlayer ->
      completedPlayer.release()
      if (player === completedPlayer) {
        player = null
        reactContext.emitDeviceEvent("VoiceRecorderPlaybackStopped", null)
      }
    }
    newPlayer.setOnErrorListener { failedPlayer, what, extra ->
      failedPlayer.release()
      val wasActive = player === failedPlayer
      if (wasActive) {
        player = null
      }
      if (settled.compareAndSet(false, true)) {
        promise.reject("AUDIO_PLAYBACK_FAILED", "音频播放失败（error: $what, $extra），请重试。")
      }
      if (wasActive) {
        reactContext.emitDeviceEvent("VoiceRecorderPlaybackStopped", null)
      }
      true
    }
    newPlayer.setDataSource(filePath)
    player = newPlayer
    newPlayer.prepare()
  }

  @ReactMethod
  fun stopPlayback(promise: Promise) {
    val activePlayer = player
    player = null
    activePlayer?.release()
    promise.resolve(null)
  }

  @ReactMethod
  fun stop(promise: Promise) {
    val activeRecorder = recorder
    val audioFile = outputFile
    if (activeRecorder == null || audioFile == null) {
      promise.reject("RECORDER_INACTIVE", "当前没有正在进行的录音。")
      return
    }

    try {
      activeRecorder.stop()
      promise.resolve("file://${audioFile.absolutePath}")
    } catch (error: RuntimeException) {
      audioFile.delete()
      promise.reject("RECORDING_STOP_FAILED", "录音保存失败，请重新录音后再试。", error)
    } finally {
      activeRecorder.release()
      recorder = null
      outputFile = null
    }
  }

  override fun invalidate() {
    recorder?.release()
    player?.release()
    recorder = null
    player = null
    outputFile = null
    super.invalidate()
  }

  private fun sha256(input: String): String {
    val digest = MessageDigest.getInstance("SHA-256")
    val hashBytes = digest.digest(input.toByteArray())
    return hashBytes.joinToString("") { "%02x".format(it) }
  }
}

private fun java.io.InputStream.copyTo(out: java.io.OutputStream, bufferSize: Int = 8192): Long {
  var bytesCopied: Long = 0
  val buffer = ByteArray(bufferSize)
  var bytes = read(buffer)
  while (bytes >= 0) {
    out.write(buffer, 0, bytes)
    bytesCopied += bytes
    bytes = read(buffer)
  }
  return bytesCopied
}
