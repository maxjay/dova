Register-ArgumentCompleter -Native -CommandName dova -ScriptBlock {
    param($word, $ast)
    $words = @($ast.CommandElements | Select-Object -Skip 1 | ForEach-Object { "$_" })
    # PowerShell drops empty arguments, so a word not yet started is announced with a flag instead.
    if ($word -eq '') { dova __complete --new-word -- @words } else { dova __complete -- @words }
}
