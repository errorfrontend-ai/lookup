Pod::Spec.new do |s|
  s.name             = 'device_services'
  s.version          = '1.0.0'
  s.summary          = "Look Up's own platform services (not supported on iOS in Phase 6)."
  s.homepage         = 'https://example.com/look-up'
  s.license          = { :type => 'Proprietary' }
  s.author           = { 'Look Up' => 'team@example.com' }
  s.source           = { :path => '.' }
  s.source_files     = 'Classes/**/*'
  s.dependency 'Flutter'
  s.platform         = :ios, '13.0'
  s.swift_version    = '5.0'
end
