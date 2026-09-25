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
import java.io.RandomAccessFile

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
      // Demo uploads use a larger but still commonly supported AAC bitrate, so a short recording reaches a 1 MiB upload part sooner.
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
    val newPlayer = MediaPlayer()
    try {
      newPlayer.setDataSource(url)
      newPlayer.setOnPreparedListener {
        it.start()
        promise.resolve(null)
      }
      newPlayer.setOnCompletionListener { completedPlayer ->
        completedPlayer.release()
        if (player === completedPlayer) {
          player = null
          reactContext.emitDeviceEvent("VoiceRecorderPlaybackStopped", null)
        }
      }
      newPlayer.setOnErrorListener { failedPlayer, _, _ ->
        failedPlayer.release()
        if (player === failedPlayer) {
          player = null
          reactContext.emitDeviceEvent("VoiceRecorderPlaybackStopped", null)
        }
        promise.reject("AUDIO_PLAYBACK_FAILED", "无法播放该录音，请稍后重试。")
        true
      }
      player = newPlayer
      newPlayer.prepareAsync()
    } catch (error: Exception) {
      newPlayer.release()
      if (player === newPlayer) {
        player = null
      }
      promise.reject("AUDIO_PLAYBACK_FAILED", "无法播放该录音，请稍后重试。", error)
    }
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
}
