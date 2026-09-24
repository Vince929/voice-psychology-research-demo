package com.voicepsychologymobile

import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

class VoiceRecorderModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  private var recorder: MediaRecorder? = null
  private var player: MediaPlayer? = null
  private var outputFile: File? = null

  override fun getName(): String = "VoiceRecorder"

  @ReactMethod
  fun start(promise: Promise) {
    if (recorder != null) {
      promise.reject("RECORDER_ACTIVE", "A recording is already in progress.")
      return
    }

    val audioFile = File(reactContext.cacheDir, "voice-${System.currentTimeMillis()}.m4a")
    val newRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(reactContext) else MediaRecorder()

    try {
      newRecorder.setAudioSource(MediaRecorder.AudioSource.MIC)
      newRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
      newRecorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
      newRecorder.setAudioSamplingRate(44_100)
      newRecorder.setAudioEncodingBitRate(128_000)
      newRecorder.setOutputFile(audioFile.absolutePath)
      newRecorder.prepare()
      newRecorder.start()
      recorder = newRecorder
      outputFile = audioFile
      promise.resolve("file://${audioFile.absolutePath}")
    } catch (error: Exception) {
      newRecorder.release()
      audioFile.delete()
      promise.reject("RECORDING_START_FAILED", error.message ?: error.javaClass.simpleName, error)
    }
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
      newPlayer.setOnCompletionListener {
        it.release()
        if (player === it) {
          player = null
        }
      }
      newPlayer.setOnErrorListener { failedPlayer, _, _ ->
        failedPlayer.release()
        if (player === failedPlayer) {
          player = null
        }
        promise.reject("AUDIO_PLAYBACK_FAILED", "The audio stream could not be played.")
        true
      }
      player = newPlayer
      newPlayer.prepareAsync()
    } catch (error: Exception) {
      newPlayer.release()
      if (player === newPlayer) {
        player = null
      }
      promise.reject("AUDIO_PLAYBACK_FAILED", error.message ?: error.javaClass.simpleName, error)
    }
  }

  @ReactMethod
  fun stopPlayback(promise: Promise) {
    player?.release()
    player = null
    promise.resolve(null)
  }

  @ReactMethod
  fun stop(promise: Promise) {
    val activeRecorder = recorder
    val audioFile = outputFile
    if (activeRecorder == null || audioFile == null) {
      promise.reject("RECORDER_INACTIVE", "No recording is in progress.")
      return
    }

    try {
      activeRecorder.stop()
      promise.resolve("file://${audioFile.absolutePath}")
    } catch (error: RuntimeException) {
      audioFile.delete()
      promise.reject("RECORDING_STOP_FAILED", error.message ?: error.javaClass.simpleName, error)
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
